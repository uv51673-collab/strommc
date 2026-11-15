// aiActionService.js — lets staff give the bot orders in plain words by pinging it:
//   "@Bot kick @user for spamming", "@Bot timeout @user 10 min", "@Bot delete last 20 messages",
//   "@Bot make a private channel for @Mods", "@Bot give @user the VIP role" ...
// What the bot can do is defined in aiActions/registry.js.
//
// Safety model (the AI only *suggests*, code decides):
//  * The model returns JSON; every action is validated and whitelisted by the registry.
//  * User targets must be users actually mentioned in the message (no invented IDs).
//  * The staff member AND the bot need the real Discord permission; role hierarchy applies.
//  * If any action is risky (kick, ban, purge, deletes) the whole batch waits for a Confirm
//    button from the person who asked. Safe batches run directly. Either way a result embed
//    lists everything that happened.
//  * Nothing here locks or restricts chat.

import {
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
} from 'discord.js';
import { askGemini } from './geminiService.js';
import { ACTION_TYPES } from './aiActions/registry.js';
import { cleanText } from './aiActions/helpers.js';
import { normalizeName } from './aiServerSetupService.js';
import { logger } from '../utils/logger.js';

export const ACTION_LIMITS = { maxActions: 10, maxModeration: 5, confirmMs: 120000 };

const SAFE_MENTIONS = { parse: [], repliedUser: false };
const COLORS = { info: 0x5865f2, ok: 0x57f287, warn: 0xfee75c, error: 0xed4245 };

// Cheap local check so ordinary questions keep their fast path (no extra AI call).
const ACTION_WORDS = /\b(kick|ban|timeout|mute|unmute|purge|delete|rename|assign|role|roles|channel|channels|category|categories|voice|forum|stage|announcement|announcements|private|community|banao|bana|nikalo|nikal|hatao|send|bhej|bhejo|bhejna|post|announce|msg|paste|edit|likh|likho|daal|dal|audit|report|nickname|nick|move|event|events|topic|color|colour|humans|bots|disconnect|tournament|members|welcome|goodbye|verification|verify|ticket|tickets|giveaway|logging|logs|setup|autorole|panel|log)\b/i;
export function looksLikeActionRequest(text) {
  return ACTION_WORDS.test(String(text ?? ''));
}

function buildSystemInstruction(client) {
  return [
    'You turn a Discord staff member\'s message into JSON actions. Reply with JSON only, no markdown.',
    'Schema: {"reply":"short answer in the staff member\'s language","actions":[ ...actions ]}',
    'Allowed actions (use exactly these shapes):',
    ...Object.values(ACTION_TYPES).flatMap((entry) => (entry.prompt ? [`- ${entry.prompt}`] : (entry.promptLines?.(client) ?? []))),
    'run_command sets up existing systems (welcome, goodbye, verification, tickets, logging, giveaways, auto-role). Use only the exact command/option names above; channels and roles by name or id.',
    'Rules: only use user IDs from "mentionedUsers". Never invent users. Channels may be referenced by id or name from "channels".',
    '"private" = only the listed roles, the requester and the bot can see it. "community" or normal = public.',
    'If the staff member says "this / ise / isko / ye" without giving text, they mean "repliedMessage" in the context: use its text (polish it) as the content.',
    'To delete everything and rebuild, return delete_all_channels first and then create_layout. For a full server layout or 10+ channels use create_layout, not many create_channel actions.',
    `For events: the current time is given as "nowIso"; the staff member is in UTC offset "${process.env.BOT_UTC_OFFSET || '+05:30'}" unless they say otherwise. Prefer startsInMinutes for relative times.`,
    'Use audit_server for "find problems / improve security" and server_report for statistics. Prefer bulk_role for "give everyone / all humans / all bots a role".',
    'Pick fitting emojis yourself. You can never lock channels, change permissions or give admin rights.',
    `If the message is just a question or you cannot do it, return an empty actions list and put a short helpful answer (under 400 characters) in "reply". At most ${ACTION_LIMITS.maxActions} actions.`,
    'Reply in the same language as the staff member (Hinglish is fine).',
  ].join('\n');
}

/** Validates the model output. Pure function: no Discord calls. */
export function sanitizeActions(raw, ctx) {
  const actions = [];
  const refused = [];
  const list = Array.isArray(raw?.actions) ? raw.actions : [];
  let moderation = 0;

  for (const item of list.slice(0, ACTION_LIMITS.maxActions)) {
    const type = String(item?.type ?? '');
    const entry = Object.hasOwn(ACTION_TYPES, type) ? ACTION_TYPES[type] : null;
    if (!entry) {
      refused.push(`unknown action "${type.slice(0, 20)}"`);
      continue;
    }

    const result = entry.sanitize(item, ctx);
    if (typeof result === 'string') {
      refused.push(result);
      continue;
    }
    if (entry.group === 'moderation') {
      if (moderation >= ACTION_LIMITS.maxModeration) {
        refused.push(`${type}: too many moderation actions in one message (max ${ACTION_LIMITS.maxModeration})`);
        continue;
      }
      moderation++;
    }
    actions.push(result);
  }

  return { actions, refused, reply: cleanText(raw?.reply, 600) };
}

/** Does this staff member + the bot really have the permission for the action? */
export function checkPermissions(action, invoker, botMember) {
  const [flag, label] = ACTION_TYPES[action.type].permission;
  if (!invoker?.permissions?.has(flag)) return `you need the **${label}** permission`;
  if (ACTION_TYPES[action.type].botPermission !== false && !botMember?.permissions?.has(flag)) return `I need the **${label}** permission`;
  return null;
}

export const isRisky = (action) => {
  const risky = ACTION_TYPES[action.type]?.risky;
  return typeof risky === 'function' ? Boolean(risky(action)) : Boolean(risky);
};
const describe = (action) => ACTION_TYPES[action.type].describe(action);
const label = (action) => action.type.replace(/_/g, ' ');

function parseJson(text) {
  const trimmed = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('not json');
  }
}

// Plain EmbedBuilder data on purpose: the shared createEmbed() helper strips emojis.
const embed = (color, title, description) =>
  new EmbedBuilder({ color: COLORS[color], title, description: String(description).slice(0, 4000) });

/** Ask Gemini what the staff member wants. Throws an error with `userMessage` on failure. */
export async function planActions(message, text, replied = null) {
  const { guild } = message;
  const mentionedUsers = [...message.mentions.users.values()]
    .filter((u) => u.id !== message.client.user.id)
    .map((u) => ({ id: u.id, tag: u.tag ?? u.username }));
  const context = {
    mentionedUsers,
    mentionedRoles: [...message.mentions.roles.values()].map((r) => r.name),
    roles: [...guild.roles.cache.values()].filter((r) => r.id !== guild.id && !r.managed).slice(0, 40).map((r) => r.name),
    categories: [...guild.channels.cache.values()].filter((c) => c.type === ChannelType.GuildCategory).slice(0, 25).map((c) => c.name),
    channels: [...guild.channels.cache.values()]
      .filter((c) => c.type !== ChannelType.GuildCategory && !c.isThread?.())
      .slice(0, 60)
      .map((c) => ({ id: c.id, name: c.name, type: [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(c.type) ? 'voice' : 'text' })),
    nowIso: new Date().toISOString(),
    mentionedChannels: [...(message.mentions.channels?.values?.() ?? [])].map((c) => ({ id: c.id, name: c.name })),
    currentChannel: { id: message.channel.id, name: message.channel.name },
    repliedMessage: replied ? { author: replied.author, text: replied.text } : null,
  };

  const answer = await askGemini(`Staff message: ${text}\n\nContext (JSON): ${JSON.stringify(context)}`, {
    systemInstruction: buildSystemInstruction(message.client),
    maxOutputTokens: 2048,
    json: true,
    maxQuestionLength: 6000,
    totalTimeoutMs: 30000,
  });

  try {
    return { raw: parseJson(answer), mentionedUserIds: new Set(mentionedUsers.map((u) => u.id)) };
  } catch {
    const error = new Error('invalid JSON from Gemini');
    error.userMessage = 'I could not understand that as an action. Please say it more clearly.';
    throw error;
  }
}

/** Entry point from botMentionService. Runs in the background. */
export async function handleActionRequest(message, text, { replied = null } = {}) {
  const { guild, client } = message;
  const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
  const reaction = await message.react('⏳').catch(() => null);
  const clear = () => {
    clearInterval(typing);
    reaction?.users?.remove(client.user.id).catch(() => {});
  };
  const send = (payload) => message.reply({ ...payload, allowedMentions: SAFE_MENTIONS }).catch((e) => {
    logger.warn(`ai action: reply failed: ${e?.message}`);
    return null;
  });

  try {
    message.channel.sendTyping().catch(() => {});
    const invoker = message.member ?? (await guild.members.fetch(message.author.id));
    const botMember = guild.members.me;

    let plan;
    try {
      plan = await planActions(message, text, replied);
    } catch (error) {
      clear();
      if (!error?.userMessage) logger.error('ai action: planning failed', error);
      await send({ content: error?.userMessage || 'Something went wrong. Please try again.' });
      return;
    }

    const { actions, refused, reply } = sanitizeActions(plan.raw, {
      mentionedUserIds: plan.mentionedUserIds,
      botId: client.user.id,
      invokerId: message.author.id,
    });

    // Roles created earlier in the same batch may be given/removed later in it.
    const plannedRoles = new Set(actions.filter((a) => a.type === 'create_role').map((a) => normalizeName(a.name)));
    const env = { message, guild, invoker, client, categoriesMade: new Map(), protectedIds: new Set([message.id]), plannedRoles };

    // delete_all_channels first, create_layout last (see `order` in the registry).
    actions.sort((a, b) => (ACTION_TYPES[a.type].order ?? 1) - (ACTION_TYPES[b.type].order ?? 1));

    const allowed = [];
    for (const action of actions) {
      const entry = ACTION_TYPES[action.type];
      const permissionProblem = checkPermissions(action, invoker, botMember);
      const problem = permissionProblem
        ? `${label(action)}: ${permissionProblem}`
        : ((await entry.validate?.(action, env)) ?? null);
      if (problem) refused.push(problem);
      else {
        allowed.push(action);
        if (action.type === 'delete_all_channels' && action.scope === 'all') env.plannedWipe = true;
      }
    }

    clear();

    const skipped = refused.length ? `\n\n*Skipped:*\n${refused.map((r) => `• ${r}`).join('\n')}` : '';

    if (!allowed.length) {
      const lines = refused.length ? `\n\n${refused.map((r) => `• ${r}`).join('\n')}` : '';
      await send({ content: `${reply || 'I could not find anything I can do for that.'}${lines}`.slice(0, 1900) });
      return;
    }

    const planText = allowed.map(describe).join('\n');
    let target = null; // message that will show the result
    let lastProgressAt = 0;
    env.progress = (progressText) => {
      const now = Date.now();
      if (!target || now - lastProgressAt < 1500) return;
      lastProgressAt = now;
      target.edit({ embeds: [embed('info', '⚙️ Working…', progressText)], components: [] }).catch(() => {});
    };

    if (allowed.some(isRisky)) {
      const buttons = (disabled) => [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('aiact_confirm').setLabel('Confirm').setStyle(ButtonStyle.Danger).setDisabled(disabled),
          new ButtonBuilder().setCustomId('aiact_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        ),
      ];
      target = await send({
        embeds: [embed(
          'warn',
          allowed.some((a) => ACTION_TYPES[a.type].destructive) ? '⚠️ Confirm — this cannot be undone' : '⚠️ Confirm these actions',
          `${planText}${skipped}\n\nOnly you can confirm. Expires in 2 minutes.`,
        )],
        components: buttons(false),
      });
      if (!target) return;
      env.protectedIds.add(target.id);

      let click;
      try {
        click = await target.awaitMessageComponent({
          componentType: ComponentType.Button,
          time: ACTION_LIMITS.confirmMs,
          filter: (i) => {
            if (i.user.id === message.author.id) return true;
            i.reply({ content: 'Only the person who asked can use these buttons.', ephemeral: true }).catch(() => {});
            return false;
          },
        });
      } catch {
        await target.edit({ embeds: [embed('warn', 'Timed out', 'Nothing was done.')], components: [] }).catch(() => {});
        return;
      }
      if (click.customId === 'aiact_cancel') {
        await click.update({ embeds: [embed('warn', 'Cancelled', 'Nothing was done.')], components: [] }).catch(() => {});
        return;
      }
      await click.update({ embeds: [embed('info', '⚙️ Working…', 'Starting…')], components: [] }).catch(() => {});
    }

    const lines = [];
    let failed = 0;
    for (const action of allowed) {
      try {
        lines.push(`✅ ${await ACTION_TYPES[action.type].run(action, env)}`);
      } catch (error) {
        failed++;
        logger.warn(`ai action ${action.type} failed: ${error?.message}`);
        lines.push(`❌ ${describe(action)} — ${error?.userMessage || error?.message || 'failed'}`);
      }
    }
    if (refused.length) lines.push(skipped.trim());

    const finalEmbed = embed(failed ? 'warn' : 'ok', failed ? 'Done, with problems' : '✅ Done', lines.join('\n'));
    if (target) await target.edit({ embeds: [finalEmbed], components: [] }).catch(() => send({ embeds: [finalEmbed] }));
    else await send({ embeds: [finalEmbed] });
  } catch (error) {
    clear();
    logger.error('ai action: unexpected error', error);
    await send({ content: 'Something went wrong while doing that. Please check the server and try again.' });
  }
}
