// aiActionService.js — lets staff give the bot orders in plain words by pinging it:
//   "@Bot kick @user for spamming", "@Bot ban @user", "@Bot make a private channel for @Mods",
//   "@Bot community announcements channel under Info".
//
// Safety model (the AI only *suggests*, code decides):
//  * The model returns JSON; every action is validated and whitelisted here.
//  * kick/ban targets must be users actually mentioned in the message (no invented IDs).
//  * The staff member needs the real Discord permission, the bot needs it too, and the normal
//    role-hierarchy checks of ModerationService apply.
//  * kick/ban always wait for a Confirm button press from the person who asked.

import {
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
} from 'discord.js';
import { askGemini } from './geminiService.js';
import { ModerationService } from './moderation/moderationService.js';
import {
  normalizeName,
  composeCategoryName,
  composeTextName,
  composeVoiceName,
} from './aiServerSetupService.js';
import { logger } from '../utils/logger.js';

export const ACTION_LIMITS = { maxActions: 5, maxModeration: 3, confirmMs: 60000 };

const SAFE_MENTIONS = { parse: [], repliedUser: false };
const COLORS = { info: 0x5865f2, ok: 0x57f287, warn: 0xfee75c, error: 0xed4245 };
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}️?(?:‍\p{Extended_Pictographic}️?)*)$/u;
const KINDS = new Set(['text', 'voice', 'announcement', 'forum', 'stage']);

// Cheap local check so ordinary questions keep their fast path (no extra AI call).
const ACTION_WORDS = /\b(kick|ban|channel|channels|category|categories|voice|forum|stage|announcement|announcements|private|community|banao|bana|nikalo|nikal|hatao)\b/i;
export function looksLikeActionRequest(text) {
  return ACTION_WORDS.test(String(text ?? ''));
}

const SYSTEM_INSTRUCTION = [
  'You turn a Discord staff member\'s message into JSON actions. Reply with JSON only, no markdown.',
  'Schema: {"reply":"short answer in the staff member\'s language","actions":[',
  '{"type":"kick","userId":"<id from mentioned users>","reason":"short"},',
  '{"type":"ban","userId":"<id from mentioned users>","reason":"short"},',
  '{"type":"create_channel","name":"words","kind":"text|voice|announcement|forum|stage","privacy":"public|private","emoji":"one emoji","category":"category name or null","allowedRoles":["role names"],"topic":"short"},',
  '{"type":"create_category","name":"words","emoji":"one emoji","privacy":"public|private","allowedRoles":["role names"]}]}',
  'Rules: only use user IDs from the "mentionedUsers" list. Never invent users.',
  '"private" = only the listed roles, the requester and the bot can see it. "community" or normal = public.',
  'Pick a fitting emoji yourself. If the message is just a question or you cannot do it, return an empty actions list and put a short helpful answer (under 400 characters) in "reply".',
  'At most 5 actions. Reply in the same language as the staff member (Hinglish is fine).',
].join('\n');

/** Validates the model output. Pure function: no Discord calls. */
export function sanitizeActions(raw, ctx) {
  const actions = [];
  const refused = [];
  const list = Array.isArray(raw?.actions) ? raw.actions : [];
  let moderation = 0;

  for (const item of list.slice(0, ACTION_LIMITS.maxActions)) {
    const type = String(item?.type ?? '');

    if (type === 'kick' || type === 'ban') {
      const userId = String(item?.userId ?? '');
      if (!ctx.mentionedUserIds.has(userId)) {
        refused.push(`${type}: that user was not mentioned in your message`);
        continue;
      }
      if (userId === ctx.botId || userId === ctx.invokerId) {
        refused.push(`${type}: I will not do that to ${userId === ctx.botId ? 'myself' : 'you'}`);
        continue;
      }
      if (moderation >= ACTION_LIMITS.maxModeration) {
        refused.push(`${type}: too many kicks/bans in one message (max ${ACTION_LIMITS.maxModeration})`);
        continue;
      }
      moderation++;
      actions.push({
        type,
        userId,
        reason: cleanText(item?.reason, 200) || 'Requested via bot ping',
      });
      continue;
    }

    if (type === 'create_channel' || type === 'create_category') {
      const name = cleanText(item?.name, 60);
      if (!normalizeName(name)) {
        refused.push('channel: no usable name');
        continue;
      }
      const emoji = EMOJI_ONLY.test(String(item?.emoji ?? '').trim())
        ? String(item.emoji).trim()
        : null;
      const privacy = String(item?.privacy).toLowerCase() === 'private' ? 'private' : 'public';
      const allowedRoles = (Array.isArray(item?.allowedRoles) ? item.allowedRoles : [])
        .map((r) => cleanText(r, 60))
        .filter(Boolean)
        .slice(0, 8);

      if (type === 'create_category') {
        actions.push({ type, name, emoji: emoji ?? '📁', privacy, allowedRoles });
      } else {
        const kind = KINDS.has(String(item?.kind).toLowerCase()) ? String(item.kind).toLowerCase() : 'text';
        const defaultEmoji = kind === 'voice' || kind === 'stage' ? '🔊' : kind === 'announcement' ? '📢' : '💬';
        actions.push({
          type,
          name,
          kind,
          privacy,
          emoji: emoji ?? defaultEmoji,
          category: cleanText(item?.category, 60) || null,
          allowedRoles,
          topic: cleanText(item?.topic, 200),
        });
      }
      continue;
    }

    refused.push(`unknown action "${type.slice(0, 20)}"`);
  }

  return { actions, refused, reply: cleanText(raw?.reply, 600) };
}

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/@(everyone|here)/gi, '')
    .replace(/[<>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Does this staff member + the bot really have the permission for the action? */
export function checkPermissions(action, invoker, botMember) {
  const need =
    action.type === 'kick'
      ? [PermissionFlagsBits.KickMembers, 'Kick Members']
      : action.type === 'ban'
        ? [PermissionFlagsBits.BanMembers, 'Ban Members']
        : [PermissionFlagsBits.ManageChannels, 'Manage Channels'];
  if (!invoker?.permissions?.has(need[0])) return `you need the **${need[1]}** permission`;
  if (!botMember?.permissions?.has(need[0])) return `I need the **${need[1]}** permission`;
  return null;
}

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

function describe(action) {
  if (action.type === 'kick') return `👢 Kick <@${action.userId}> — ${action.reason}`;
  if (action.type === 'ban') return `🔨 Ban <@${action.userId}> — ${action.reason}`;
  const lock = action.privacy === 'private' ? '🔒 private' : '🌐 public';
  if (action.type === 'create_category') return `📁 Category ${composeCategoryName(action.emoji, action.name)} (${lock})`;
  const shown = action.kind === 'voice' || action.kind === 'stage'
    ? composeVoiceName(action.emoji, action.name)
    : composeTextName(action.emoji, action.name);
  return `➕ ${action.kind} channel ${shown} (${lock})${action.category ? ` in ${action.category}` : ''}`;
}

const embed = (color, title, description) =>
  new EmbedBuilder({ color: COLORS[color], title, description: String(description).slice(0, 4000) });

function findRoleIds(guild, names) {
  const ids = [];
  for (const wanted of names) {
    const key = normalizeName(wanted);
    if (!key) continue;
    const role = [...guild.roles.cache.values()].find(
      (r) => r.id !== guild.id && (normalizeName(r.name) === key || r.id === wanted),
    );
    if (role) ids.push(role.id);
  }
  return ids;
}

function privateOverwrites(guild, invokerId, botId, roleIds) {
  const see = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.Connect];
  return [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: invokerId, allow: see },
    { id: botId, allow: [...see, PermissionFlagsBits.ManageChannels] },
    ...roleIds.map((id) => ({ id, allow: see })),
  ];
}

async function resolveCategory(guild, name, created) {
  const key = normalizeName(name);
  if (!key) return null;
  const existing = [...guild.channels.cache.values()].find(
    (c) => c.type === ChannelType.GuildCategory && normalizeName(c.name) === key,
  );
  if (existing) return existing.id;
  if (created.has(key)) return created.get(key);
  const made = await guild.channels.create({
    name: composeCategoryName('📁', name),
    type: ChannelType.GuildCategory,
    reason: 'AI action (bot ping)',
  });
  created.set(key, made.id);
  return made.id;
}

const TYPE_BY_KIND = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  stage: ChannelType.GuildStageVoice,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
};

/** Runs one validated action. Returns a result line; throws on failure. */
async function runAction(action, { message, guild, invoker, client, categoriesMade }) {
  if (action.type === 'kick') {
    const member = await guild.members.fetch(action.userId).catch(() => null);
    if (!member) throw new Error('that person is not in the server');
    await ModerationService.kickUser({ guild, member, moderator: invoker, reason: action.reason });
    return `Kicked <@${action.userId}>`;
  }

  if (action.type === 'ban') {
    const user = message.mentions.users.get(action.userId) ?? (await client.users.fetch(action.userId));
    await ModerationService.banUser({ guild, user, moderator: invoker, reason: action.reason });
    return `Banned <@${action.userId}>`;
  }

  const roleIds = findRoleIds(guild, action.allowedRoles ?? []);
  const permissionOverwrites =
    action.privacy === 'private' ? privateOverwrites(guild, invoker.id, client.user.id, roleIds) : undefined;

  if (action.type === 'create_category') {
    const made = await guild.channels.create({
      name: composeCategoryName(action.emoji, action.name),
      type: ChannelType.GuildCategory,
      ...(permissionOverwrites ? { permissionOverwrites } : {}),
      reason: `AI action requested by ${invoker.user.tag}`,
    });
    categoriesMade.set(normalizeName(action.name), made.id);
    return `Created category ${made.name}`;
  }

  const parent = action.category ? await resolveCategory(guild, action.category, categoriesMade) : null;
  const isVoiceLike = action.kind === 'voice' || action.kind === 'stage';
  const name = isVoiceLike
    ? composeVoiceName(action.emoji, action.name)
    : composeTextName(action.emoji, action.name);

  const base = {
    name,
    ...(parent ? { parent } : {}),
    ...(permissionOverwrites ? { permissionOverwrites } : {}),
    ...(action.topic && !isVoiceLike ? { topic: action.topic } : {}),
    reason: `AI action requested by ${invoker.user.tag}`,
  };

  let note = '';
  let made;
  try {
    made = await guild.channels.create({ ...base, type: TYPE_BY_KIND[action.kind] });
  } catch (error) {
    // Announcement / forum / stage need the Community feature; fall back to something that works.
    if (action.kind === 'text') throw error;
    const fallbackType = action.kind === 'stage' ? ChannelType.GuildVoice : ChannelType.GuildText;
    made = await guild.channels.create({ ...base, type: fallbackType });
    note = ` (made as ${action.kind === 'stage' ? 'voice' : 'text'} — ${action.kind} needs Community enabled)`;
  }
  return `Created ${action.privacy === 'private' ? '🔒 ' : ''}${made.name}${note}`;
}

/** Ask Gemini what the staff member wants. Throws an error with `userMessage` on failure. */
export async function planActions(message, text) {
  const mentionedUsers = [...message.mentions.users.values()]
    .filter((u) => u.id !== message.client.user.id)
    .map((u) => ({ id: u.id, tag: u.tag ?? u.username }));
  const context = {
    mentionedUsers,
    mentionedRoles: [...message.mentions.roles.values()].map((r) => r.name),
    roles: [...message.guild.roles.cache.values()].filter((r) => r.id !== message.guild.id).slice(0, 25).map((r) => r.name),
    categories: [...message.guild.channels.cache.values()]
      .filter((c) => c.type === ChannelType.GuildCategory).slice(0, 25).map((c) => c.name),
  };

  const answer = await askGemini(`Staff message: ${text}\n\nContext (JSON): ${JSON.stringify(context)}`, {
    systemInstruction: SYSTEM_INSTRUCTION,
    maxOutputTokens: 1024,
    json: true,
    maxQuestionLength: 4000,
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
export async function handleActionRequest(message, text) {
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
      plan = await planActions(message, text);
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

    const allowed = [];
    for (const action of actions) {
      const problem = checkPermissions(action, invoker, botMember);
      if (problem) refused.push(`${action.type.replace('_', ' ')}: ${problem}`);
      else allowed.push(action);
    }

    clear();

    if (!allowed.length) {
      const lines = refused.length ? `\n\n${refused.map((r) => `• ${r}`).join('\n')}` : '';
      await send({ content: `${reply || 'I could not find anything I can do for that.'}${lines}`.slice(0, 1900) });
      return;
    }

    const risky = allowed.some((a) => a.type === 'kick' || a.type === 'ban');
    const planText = allowed.map(describe).join('\n') + (refused.length ? `\n\n*Skipped:*\n${refused.map((r) => `• ${r}`).join('\n')}` : '');

    let target = null; // message that will show the result
    if (risky) {
      const buttons = (disabled) => [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('aiact_confirm').setLabel('Confirm').setStyle(ButtonStyle.Danger).setDisabled(disabled),
          new ButtonBuilder().setCustomId('aiact_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        ),
      ];
      target = await send({
        embeds: [embed('warn', '⚠️ Confirm these actions', `${planText}\n\nOnly you can confirm. Expires in 60 seconds.`)],
        components: buttons(false),
      });
      if (!target) return;

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
      await click.update({ embeds: [embed('info', '⚙️ Working…', planText)], components: [] }).catch(() => {});
    }

    const lines = [];
    let failed = 0;
    const categoriesMade = new Map();
    for (const action of allowed) {
      try {
        lines.push(`✅ ${await runAction(action, { message, guild, invoker, client, categoriesMade })}`);
      } catch (error) {
        failed++;
        logger.warn(`ai action ${action.type} failed: ${error?.message}`);
        lines.push(`❌ ${describe(action)} — ${error?.userMessage || error?.message || 'failed'}`);
      }
    }
    if (refused.length) lines.push(`\n*Skipped:*\n${refused.map((r) => `• ${r}`).join('\n')}`);

    const finalEmbed = embed(failed ? 'warn' : 'ok', failed ? 'Done, with problems' : '✅ Done', lines.join('\n'));
    if (target) await target.edit({ embeds: [finalEmbed], components: [] }).catch(() => send({ embeds: [finalEmbed] }));
    else await send({ embeds: [finalEmbed] });
  } catch (error) {
    clear();
    logger.error('ai action: unexpected error', error);
    await send({ content: 'Something went wrong while doing that. Please check the server and try again.' });
  }
}
