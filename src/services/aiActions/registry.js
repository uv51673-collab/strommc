// registry.js — every order the bot understands from a ping is one entry here.
//
// Entry shape:
//   permission : [PermissionFlag, 'Label']  needed by BOTH the staff member and the bot
//   risky      : true -> the whole batch waits for a Confirm button
//   group      : 'moderation' entries share a per-message cap
//   prompt     : the schema line shown to Gemini
//   sanitize(item, ctx) -> action object, or a string (reason it was refused)
//   validate(action, env) -> null | string   (async checks against the live guild)
//   describe(action) -> text for the plan embed
//   run(action, env) -> text for the result embed (throws on failure)
//
// Gemini only *suggests*; nothing here trusts it.

import { ChannelType, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { ModerationService } from '../moderation/moderationService.js';
import {
  normalizeName,
  composeCategoryName,
  composeTextName,
  composeVoiceName,
} from '../aiServerSetupService.js';
import { requestPlan, applyPlan, renderPlan } from '../aiServerSetupService.js';
import {
  cleanText,
  cleanMessage,
  cannotWriteIn,
  cleanEmoji,
  cleanRoleList,
  findRole,
  findRoleIds,
  findChannel,
  privateOverwrites,
  resolveCategory,
  invokerOutranks,
  isPowerfulRole,
} from './helpers.js';

const KINDS = new Set(['text', 'voice', 'announcement', 'forum', 'stage']);
const TYPE_BY_KIND = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  stage: ChannelType.GuildStageVoice,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
};
const MAX_TIMEOUT_MINUTES = 28 * 24 * 60;

const userAction = (type, label) => (item, ctx) => {
  const userId = String(item?.userId ?? '');
  if (!ctx.mentionedUserIds.has(userId)) return `${label}: that user was not mentioned in your message`;
  if (userId === ctx.botId) return `${label}: I will not do that to myself`;
  if (userId === ctx.invokerId) return `${label}: I will not do that to you`;
  return { type, userId, reason: cleanText(item?.reason, 200) || 'Requested via bot ping' };
};

const isVoiceLike = (kind) => kind === 'voice' || kind === 'stage';
const channelLabel = (emoji, name, kind) =>
  isVoiceLike(kind) ? composeVoiceName(emoji, name) : composeTextName(emoji, name);

async function fetchMember(env, userId) {
  const member = await env.guild.members.fetch(userId).catch(() => null);
  if (!member) throw new Error('that person is not in the server');
  return member;
}

export const ACTION_TYPES = {
  kick: {
    permission: [PermissionFlagsBits.KickMembers, 'Kick Members'],
    risky: true,
    group: 'moderation',
    prompt: '{"type":"kick","userId":"<id from mentionedUsers>","reason":"short"}',
    sanitize: userAction('kick', 'kick'),
    describe: (a) => `👢 Kick <@${a.userId}> — ${a.reason}`,
    async run(a, env) {
      const member = await fetchMember(env, a.userId);
      await ModerationService.kickUser({ guild: env.guild, member, moderator: env.invoker, reason: a.reason });
      return `Kicked <@${a.userId}>`;
    },
  },

  ban: {
    permission: [PermissionFlagsBits.BanMembers, 'Ban Members'],
    risky: true,
    group: 'moderation',
    prompt: '{"type":"ban","userId":"<id from mentionedUsers>","reason":"short"}',
    sanitize: userAction('ban', 'ban'),
    describe: (a) => `🔨 Ban <@${a.userId}> — ${a.reason}`,
    async run(a, env) {
      const user = env.message.mentions.users.get(a.userId) ?? (await env.client.users.fetch(a.userId));
      await ModerationService.banUser({ guild: env.guild, user, moderator: env.invoker, reason: a.reason });
      return `Banned <@${a.userId}>`;
    },
  },

  timeout: {
    permission: [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
    risky: false,
    group: 'moderation',
    prompt: '{"type":"timeout","userId":"<id from mentionedUsers>","minutes":10,"reason":"short"}',
    sanitize(item, ctx) {
      const base = userAction('timeout', 'timeout')(item, ctx);
      if (typeof base === 'string') return base;
      const minutes = Math.round(Number(item?.minutes));
      if (!Number.isFinite(minutes) || minutes < 1) return 'timeout: no valid duration';
      return { ...base, minutes: Math.min(minutes, MAX_TIMEOUT_MINUTES) };
    },
    describe: (a) => `⏳ Timeout <@${a.userId}> for ${a.minutes} min — ${a.reason}`,
    async run(a, env) {
      const member = await fetchMember(env, a.userId);
      await ModerationService.timeoutUser({
        guild: env.guild, member, moderator: env.invoker, durationMs: a.minutes * 60000, reason: a.reason,
      });
      return `Timed out <@${a.userId}> for ${a.minutes} min`;
    },
  },

  untimeout: {
    permission: [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
    risky: false,
    group: 'moderation',
    prompt: '{"type":"untimeout","userId":"<id from mentionedUsers>"}',
    sanitize: userAction('untimeout', 'untimeout'),
    describe: (a) => `✅ Remove timeout from <@${a.userId}>`,
    async run(a, env) {
      const member = await fetchMember(env, a.userId);
      await ModerationService.removeTimeoutUser({ guild: env.guild, member, moderator: env.invoker });
      return `Removed timeout from <@${a.userId}>`;
    },
  },

  purge: {
    permission: [PermissionFlagsBits.ManageMessages, 'Manage Messages'],
    risky: true,
    prompt: '{"type":"purge","count":20,"userId":"<optional id from mentionedUsers>"} (deletes recent messages in THIS channel)',
    sanitize(item, ctx) {
      const count = Math.round(Number(item?.count));
      if (!Number.isFinite(count) || count < 1) return 'purge: no valid message count';
      const userId = item?.userId ? String(item.userId) : null;
      if (userId && !ctx.mentionedUserIds.has(userId)) return 'purge: that user was not mentioned in your message';
      return { type: 'purge', count: Math.min(count, 100), userId };
    },
    describe: (a) => `🧹 Delete the last ${a.count} message(s) in this channel${a.userId ? ` from <@${a.userId}>` : ''}`,
    async run(a, env) {
      const fetched = await env.message.channel.messages.fetch({ limit: 100 });
      const picked = [...fetched.values()]
        .filter((m) => !env.protectedIds.has(m.id) && !m.pinned && (!a.userId || m.author?.id === a.userId))
        .slice(0, a.count);
      if (!picked.length) return 'No messages to delete';
      const deleted = await env.message.channel.bulkDelete(picked, true);
      const note = deleted.size < picked.length ? ' (messages older than 14 days cannot be bulk deleted)' : '';
      return `Deleted ${deleted.size} message(s)${note}`;
    },
  },

  send_message: {
    permission: [PermissionFlagsBits.SendMessages, 'Send Messages'],
    risky: false,
    prompt: '{"type":"send_message","channel":"<id or name from channels/mentionedChannels, or null for the current channel>","content":"the FINAL polished text to post","asEmbed":false,"title":"embed title or null","color":"#RRGGBB or null"}  (you write the final text: fix spelling/grammar, tidy the layout with line breaks, **bold** and fitting emojis, keep the meaning and language; never add @everyone/@here)',
    sanitize(item) {
      const asEmbed = item?.asEmbed === true;
      const content = cleanMessage(item?.content, asEmbed ? 4000 : 1900);
      if (!content) return 'send message: there is no text to send';
      const color = /^#?[0-9a-f]{6}$/i.test(String(item?.color ?? '').trim())
        ? parseInt(String(item.color).trim().replace('#', ''), 16)
        : null;
      return {
        type: 'send_message',
        channel: cleanText(item?.channel, 100) || null,
        content,
        asEmbed,
        title: asEmbed ? cleanText(item?.title, 200) : '',
        color,
      };
    },
    describe: (a) =>
      `📨 Send ${a.asEmbed ? 'an embed' : 'a message'} to ${a.channel ?? 'this channel'} (${a.content.length} chars)`,
    async validate(a, env) {
      const target = resolveSendTarget(a, env);
      if (target.error) return `send message: ${target.error}`;
      return (
        cannotWriteIn(target.channel, env.invoker, 'you') ??
        cannotWriteIn(target.channel, env.guild.members.me, 'I') ??
        null
      );
    },
    async run(a, env) {
      const { channel } = resolveSendTarget(a, env);
      const payload = a.asEmbed
        ? { embeds: [new EmbedBuilder({ color: a.color ?? 0x5865f2, ...(a.title ? { title: a.title } : {}), description: a.content })] }
        : { content: a.content };
      // No pings from AI-written text: mentions render but never notify anyone.
      const sent = await channel.send({ ...payload, allowedMentions: { parse: [] } });
      return `Sent to <#${channel.id}>${sent?.url ? ` — [open message](${sent.url})` : ''}`;
    },
  },

  create_channel: {
    permission: [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
    risky: false,
    prompt: '{"type":"create_channel","name":"words","kind":"text|voice|announcement|forum|stage","privacy":"public|private","emoji":"one emoji","category":"category name or null","allowedRoles":["role names"],"topic":"short"}',
    sanitize(item) {
      const name = cleanText(item?.name, 60);
      if (!normalizeName(name)) return 'channel: no usable name';
      const kind = KINDS.has(String(item?.kind).toLowerCase()) ? String(item.kind).toLowerCase() : 'text';
      return {
        type: 'create_channel',
        name,
        kind,
        privacy: String(item?.privacy).toLowerCase() === 'private' ? 'private' : 'public',
        emoji: cleanEmoji(item?.emoji, isVoiceLike(kind) ? '🔊' : kind === 'announcement' ? '📢' : '💬'),
        category: cleanText(item?.category, 60) || null,
        allowedRoles: cleanRoleList(item?.allowedRoles),
        topic: cleanText(item?.topic, 200),
      };
    },
    describe: (a) =>
      `➕ ${a.kind} channel ${channelLabel(a.emoji, a.name, a.kind)} (${a.privacy === 'private' ? '🔒 private' : '🌐 public'})${a.category ? ` in ${a.category}` : ''}`,
    async run(a, env) {
      const { guild, invoker, client } = env;
      const roleIds = findRoleIds(guild, a.allowedRoles ?? []);
      const permissionOverwrites =
        a.privacy === 'private' ? privateOverwrites(guild, invoker.id, client.user.id, roleIds) : undefined;
      const parent = a.category ? await resolveCategory(guild, a.category, env.categoriesMade) : null;
      const base = {
        name: channelLabel(a.emoji, a.name, a.kind),
        ...(parent ? { parent } : {}),
        ...(permissionOverwrites ? { permissionOverwrites } : {}),
        ...(a.topic && !isVoiceLike(a.kind) ? { topic: a.topic } : {}),
        reason: `AI action requested by ${invoker.user.tag}`,
      };
      let made;
      let note = '';
      try {
        made = await guild.channels.create({ ...base, type: TYPE_BY_KIND[a.kind] });
      } catch (error) {
        // Announcement / forum / stage need the Community feature; fall back to something that works.
        if (a.kind === 'text') throw error;
        const fallback = a.kind === 'stage' ? ChannelType.GuildVoice : ChannelType.GuildText;
        made = await guild.channels.create({ ...base, type: fallback });
        note = ` (made as ${a.kind === 'stage' ? 'voice' : 'text'} — ${a.kind} needs Community enabled)`;
      }
      return `Created ${a.privacy === 'private' ? '🔒 ' : ''}${made.name}${note}`;
    },
  },

  create_category: {
    permission: [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
    risky: false,
    prompt: '{"type":"create_category","name":"words","emoji":"one emoji","privacy":"public|private","allowedRoles":["role names"]}',
    sanitize(item) {
      const name = cleanText(item?.name, 60);
      if (!normalizeName(name)) return 'category: no usable name';
      return {
        type: 'create_category',
        name,
        emoji: cleanEmoji(item?.emoji, '📁'),
        privacy: String(item?.privacy).toLowerCase() === 'private' ? 'private' : 'public',
        allowedRoles: cleanRoleList(item?.allowedRoles),
      };
    },
    describe: (a) => `📁 Category ${composeCategoryName(a.emoji, a.name)} (${a.privacy === 'private' ? '🔒 private' : '🌐 public'})`,
    async run(a, env) {
      const { guild, invoker, client } = env;
      const roleIds = findRoleIds(guild, a.allowedRoles ?? []);
      const made = await guild.channels.create({
        name: composeCategoryName(a.emoji, a.name),
        type: ChannelType.GuildCategory,
        ...(a.privacy === 'private'
          ? { permissionOverwrites: privateOverwrites(guild, invoker.id, client.user.id, roleIds) }
          : {}),
        reason: `AI action requested by ${invoker.user.tag}`,
      });
      env.categoriesMade.set(normalizeName(a.name), made.id);
      return `Created category ${made.name}`;
    },
  },

  rename_channel: {
    permission: [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
    risky: false,
    prompt: '{"type":"rename_channel","channel":"<id or name from channels>","newName":"words","emoji":"one emoji or null"}',
    sanitize(item) {
      const channel = cleanText(item?.channel, 100);
      const newName = cleanText(item?.newName, 60);
      if (!channel || !normalizeName(newName)) return 'rename: need the channel and a new name';
      return { type: 'rename_channel', channel, newName, emoji: cleanEmoji(item?.emoji, null) };
    },
    describe: (a) => `✏️ Rename ${a.channel} → ${a.emoji ? `${a.emoji} ` : ''}${a.newName}`,
    async validate(a, env) {
      const found = findChannel(env.guild, a.channel);
      if (found.error) return `rename: ${found.error}`;
      if (!found.channel.manageable) return `rename: I cannot edit #${found.channel.name}`;
      return null;
    },
    async run(a, env) {
      const { channel } = findChannel(env.guild, a.channel);
      let name;
      if (channel.type === ChannelType.GuildCategory) name = composeCategoryName(a.emoji ?? '📁', a.newName);
      else if (a.emoji) {
        const voice = channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice;
        name = channelLabel(a.emoji, a.newName, voice ? 'voice' : 'text');
      }
      else name = a.newName;
      const before = channel.name;
      await channel.setName(name, `AI action requested by ${env.invoker.user.tag}`);
      return `Renamed ${before} → ${name}`;
    },
  },

  delete_channel: {
    permission: [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
    risky: true,
    prompt: '{"type":"delete_channel","channel":"<id or name from channels>"}',
    sanitize(item) {
      const channel = cleanText(item?.channel, 100);
      return channel ? { type: 'delete_channel', channel } : 'delete: no channel named';
    },
    describe: (a) => `🗑️ Delete channel ${a.channel}`,
    async validate(a, env) {
      const found = findChannel(env.guild, a.channel);
      if (found.error) return `delete: ${found.error}`;
      const { channel } = found;
      if (!channel.deletable) return `delete: I cannot delete #${channel.name}`;
      if ([env.guild.rulesChannelId, env.guild.publicUpdatesChannelId].includes(channel.id)) {
        return `delete: #${channel.name} is a required Community channel`;
      }
      if (!channel.permissionsFor?.(env.invoker)?.has(PermissionFlagsBits.ViewChannel)) {
        return `delete: you cannot see #${channel.name}`;
      }
      return null;
    },
    async run(a, env) {
      const { channel } = findChannel(env.guild, a.channel);
      const name = channel.name;
      await channel.delete(`AI action requested by ${env.invoker.user.tag}`);
      return `Deleted ${name}`;
    },
  },

  delete_all_channels: {
    permission: [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
    risky: true,
    destructive: true,
    order: 0, // always runs first, so a fresh layout can be built afterwards
    prompt: '{"type":"delete_all_channels","scope":"all or a category name"}  (deletes every channel, or one category with its channels; the current channel and Community-required channels are always kept)',
    sanitize(item) {
      const scope = cleanText(item?.scope, 60);
      return {
        type: 'delete_all_channels',
        scope: !scope || /^(all|everything|sab|saare|sabhi)$/i.test(scope) ? 'all' : scope,
        ids: [],
        names: [],
      };
    },
    describe(a) {
      const shown = a.names.slice(0, 25).join(', ');
      const more = a.names.length > 25 ? ` … +${a.names.length - 25} more` : '';
      const what = a.scope === 'all' ? 'EVERY channel (except this one and Community-required ones)' : `category "${a.scope}"`;
      return `🗑️ **Delete ${a.ids.length} channel(s)** — ${what}:\n${shown}${more}`;
    },
    async validate(a, env) {
      const { guild, invoker, message } = env;
      const all = [...guild.channels.cache.values()].filter((c) => !c.isThread?.());
      let pool;
      if (a.scope === 'all') {
        const isAdmin = invoker.permissions.has(PermissionFlagsBits.Administrator) || guild.ownerId === invoker.id;
        if (!isAdmin) return 'delete all channels: only an Administrator or the server owner can wipe every channel';
        pool = all;
      } else {
        const key = normalizeName(a.scope);
        const category = all.find((c) => c.type === ChannelType.GuildCategory && normalizeName(c.name) === key);
        if (!category) return `delete channels: no category called "${a.scope}"`;
        pool = [category, ...all.filter((c) => c.parentId === category.id)];
      }
      const keep = new Set([message.channel.id, guild.rulesChannelId, guild.publicUpdatesChannelId].filter(Boolean));
      const doomed = pool.filter(
        (c) => !keep.has(c.id) && c.deletable && c.permissionsFor?.(invoker)?.has(PermissionFlagsBits.ViewChannel),
      );
      if (!doomed.length) return 'delete channels: there is nothing to delete';
      a.ids = doomed.map((c) => c.id);
      a.names = doomed.map((c) => c.name);
      return null;
    },
    async run(a, env) {
      const { guild } = env;
      const isCategory = (c) => c.type === ChannelType.GuildCategory;
      // Channels first, categories last (so empty categories can go too).
      const ordered = a.ids
        .map((id) => guild.channels.cache.get(id))
        .filter(Boolean)
        .sort((x, y) => Number(isCategory(x)) - Number(isCategory(y)));
      let done = 0;
      let keptCategories = 0;
      const failed = [];
      for (const [index, channel] of ordered.entries()) {
        if (isCategory(channel) && [...guild.channels.cache.values()].some((c) => c.parentId === channel.id)) {
          keptCategories++;
          continue;
        }
        try {
          await channel.delete(`AI action requested by ${env.invoker.user.tag}`);
          done++;
        } catch {
          failed.push(channel.name);
        }
        env.progress?.(`🗑️ Deleting channels… ${index + 1}/${ordered.length}`);
      }
      return `Deleted ${done} of ${ordered.length} channel(s)${failed.length ? `; could not delete: ${failed.slice(0, 5).join(', ')}` : ''}${keptCategories ? `; kept ${keptCategories} categor${keptCategories === 1 ? 'y' : 'ies'} that still contain channels` : ''}`;
    },
  },

  create_layout: {
    permission: [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
    risky: true,
    order: 2, // after a wipe
    prompt: '{"type":"create_layout","request":"what to build, e.g. professional gaming server with 40 channels"}  (use this for a FULL server layout or more than about 10 channels: up to 50 items with emojis, categories, voice rooms and a private staff category; for a few channels use create_channel)',
    sanitize(item) {
      const request = cleanText(item?.request, 400);
      return request ? { type: 'create_layout', request, plan: null } : 'layout: tell me what kind of server to build';
    },
    describe: (a) => `🏗️ **Build ${a.plan.total} items** (${a.plan.categories.length} categories):\n${renderPlan(a.plan, new Map(), 2200)}`,
    async validate(a, env) {
      try {
        a.plan = await requestPlan(env.guild, a.request, { fresh: Boolean(env.plannedWipe) });
        return null;
      } catch (error) {
        return `layout: ${error?.userMessage || 'I could not plan that layout'}`;
      }
    },
    async run(a, env) {
      const results = await applyPlan(
        env.guild,
        a.plan,
        (step, totals) => env.progress?.(`🏗️ Building your server… ${totals.created + totals.failed}/${a.plan.total}`),
        { invokerId: env.invoker.id, botId: env.client.user.id },
      );
      const failures = results.steps.filter((step) => step.status === 'fail');
      return `Created ${results.created} of ${a.plan.total} items${failures.length ? ` (${failures.length} failed: ${failures.slice(0, 3).map((f) => f.label).join(', ')})` : ''}`;
    },
  },

  create_role: {
    permission: [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
    risky: false,
    prompt: '{"type":"create_role","name":"words","color":"#RRGGBB or null","hoist":false}  (roles are created with NO permissions)',
    sanitize(item) {
      const name = cleanText(item?.name, 60);
      if (!normalizeName(name)) return 'role: no usable name';
      const color = /^#?[0-9a-f]{6}$/i.test(String(item?.color ?? '').trim())
        ? `#${String(item.color).trim().replace('#', '')}`
        : null;
      return { type: 'create_role', name, color, hoist: item?.hoist === true };
    },
    describe: (a) => `🎭 Create role ${a.name}${a.color ? ` (${a.color})` : ''}`,
    async run(a, env) {
      const role = await env.guild.roles.create({
        name: a.name,
        ...(a.color ? { color: a.color } : {}),
        hoist: a.hoist,
        mentionable: false,
        permissions: [], // never hand out permissions through the AI
        reason: `AI action requested by ${env.invoker.user.tag}`,
      });
      return `Created role ${role.name}`;
    },
  },

  delete_role: {
    permission: [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
    risky: true,
    prompt: '{"type":"delete_role","role":"<role name>"}',
    sanitize(item) {
      const role = cleanText(item?.role, 60);
      return role ? { type: 'delete_role', role } : 'delete role: no role named';
    },
    describe: (a) => `🗑️ Delete role ${a.role}`,
    async validate(a, env) {
      const role = findRole(env.guild, a.role);
      if (!role) return `delete role: no role called "${a.role}"`;
      if (!role.editable) return `delete role: I cannot edit ${role.name} (it is above my role or managed)`;
      if (!invokerOutranks(env.invoker, role)) return `delete role: ${role.name} is not below your highest role`;
      return null;
    },
    async run(a, env) {
      const role = findRole(env.guild, a.role);
      const name = role.name;
      await role.delete(`AI action requested by ${env.invoker.user.tag}`);
      return `Deleted role ${name}`;
    },
  },

  give_role: roleAssignment('give_role', 'add', '🎭 Give', 'Gave'),
  remove_role: roleAssignment('remove_role', 'remove', '➖ Remove', 'Removed'),
};

function roleAssignment(type, method, verbEmoji, verbPast) {
  const word = type === 'give_role' ? 'give' : 'remove';
  return {
    permission: [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
    risky: false,
    prompt: `{"type":"${type}","userId":"<id from mentionedUsers>","role":"<role name>"}`,
    sanitize(item, ctx) {
      const userId = String(item?.userId ?? '');
      const role = cleanText(item?.role, 60);
      if (!ctx.mentionedUserIds.has(userId)) return `${word} role: that user was not mentioned in your message`;
      if (!role) return `${word} role: no role named`;
      return { type, userId, role };
    },
    describe: (a) => `${verbEmoji} role ${a.role} ${type === 'give_role' ? 'to' : 'from'} <@${a.userId}>`,
    async validate(a, env) {
      const role = findRole(env.guild, a.role);
      if (!role && env.plannedRoles?.has(normalizeName(a.role))) return null; // created earlier in this batch
      if (!role) return `${word} role: no role called "${a.role}"`;
      if (!role.editable) return `${word} role: I cannot manage ${role.name} (it is above my role or managed)`;
      if (!invokerOutranks(env.invoker, role)) return `${word} role: ${role.name} is not below your highest role`;
      const isAdmin = env.invoker.permissions.has(PermissionFlagsBits.Administrator) || env.guild.ownerId === env.invoker.id;
      if (!isAdmin && isPowerfulRole(role)) {
        return `${word} role: ${role.name} has powerful permissions; only an Administrator can hand it out`;
      }
      return null;
    },
    async run(a, env) {
      const member = await fetchMember(env, a.userId);
      const role = findRole(env.guild, a.role);
      await member.roles[method](role, `AI action requested by ${env.invoker.user.tag}`);
      return `${verbPast} role ${role.name} ${type === 'give_role' ? 'to' : 'from'} <@${a.userId}>`;
    },
  };
}

function resolveSendTarget(a, env) {
  if (!a.channel) return { channel: env.message.channel };
  const found = findChannel(env.guild, a.channel);
  if (found.error) return found;
  if (!found.channel.isTextBased?.() || found.channel.type === ChannelType.GuildCategory) {
    return { error: `#${found.channel.name} is not a channel I can post in` };
  }
  return found;
}
