// manageActions.js — management orders: role edits and bulk role changes, moving channels,
// topics, channel visibility, nicknames, voice moves, Discord events, server audit and report.
// Same entry shape as registry.js (see the header there). Nothing here can lock chat.

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { normalizeName } from '../aiServerSetupService.js';
import {
  cleanText,
  findRole,
  findRoleIds,
  findChannel,
  resolveCategory,
  invokerOutranks,
  isPowerfulRole,
} from './helpers.js';
import { auditGuild, formatAudit, reportGuild } from './serverInsights.js';

const MAX_BULK_MEMBERS = 500;
const MAX_BULK_GUILD_SIZE = 2000;
const MAX_REPORT_FETCH = 5000;
const SCHEDULED_EVENT = { guildOnly: 2, stage: 1, voice: 2, external: 3 };

const isVoiceLike = (c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice;
const mentioned = (item, ctx, label) => {
  const userId = String(item?.userId ?? '');
  return ctx.mentionedUserIds.has(userId) ? userId : null;
};

async function fetchMember(env, userId) {
  const member = await env.guild.members.fetch(userId).catch(() => null);
  if (!member) throw new Error('that person is not in the server');
  return member;
}

/** Staff may only touch members below their own highest role (the owner may touch anyone). */
function outranksMember(invoker, member) {
  if (invoker.guild?.ownerId === invoker.id) return true;
  return (invoker.roles?.highest?.position ?? -1) > (member.roles?.highest?.position ?? 0);
}

function roleProblem(a, env, word) {
  const role = findRole(env.guild, a.role);
  if (!role) return { role: null, problem: env.plannedRoles?.has(normalizeName(a.role)) ? null : `${word}: no role called "${a.role}"` };
  if (!role.editable) return { role, problem: `${word}: I cannot manage ${role.name} (it is above my role or managed)` };
  if (!invokerOutranks(env.invoker, role)) return { role, problem: `${word}: ${role.name} is not below your highest role` };
  const isAdmin = env.invoker.permissions.has(PermissionFlagsBits.Administrator) || env.guild.ownerId === env.invoker.id;
  if (!isAdmin && isPowerfulRole(role)) return { role, problem: `${word}: ${role.name} has powerful permissions; only an Administrator can change it` };
  return { role, problem: null };
}

export const MANAGE_ACTIONS = {
  edit_role: {
    permission: [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
    risky: false,
    prompt: '{"type":"edit_role","role":"<role name>","newName":"new name or null","color":"#RRGGBB or null","hoist":true|false|null}  (name/colour/display only; never permissions)',
    sanitize(item) {
      const role = cleanText(item?.role, 60);
      const newName = cleanText(item?.newName, 60) || null;
      const color = /^#?[0-9a-f]{6}$/i.test(String(item?.color ?? '').trim()) ? `#${String(item.color).trim().replace('#', '')}` : null;
      const hoist = typeof item?.hoist === 'boolean' ? item.hoist : null;
      if (!role) return 'edit role: no role named';
      if (!newName && !color && hoist === null) return 'edit role: nothing to change';
      return { type: 'edit_role', role, newName, color, hoist };
    },
    describe: (a) => `🎨 Edit role ${a.role}${a.newName ? ` → ${a.newName}` : ''}${a.color ? ` (${a.color})` : ''}`,
    async validate(a, env) {
      const { role, problem } = roleProblem(a, env, 'edit role');
      if (problem) return problem;
      if (!role) return `edit role: no role called "${a.role}"`;
      return null;
    },
    async run(a, env) {
      const role = findRole(env.guild, a.role);
      const before = role.name;
      await role.edit({
        ...(a.newName ? { name: a.newName } : {}),
        ...(a.color ? { color: a.color } : {}),
        ...(a.hoist !== null ? { hoist: a.hoist } : {}),
        reason: `AI action requested by ${env.invoker.user.tag}`,
      });
      return `Edited role ${before}${a.newName ? ` → ${a.newName}` : ''}`;
    },
  },

  bulk_role: {
    permission: [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
    risky: true,
    prompt: '{"type":"bulk_role","role":"<role name>","audience":"humans|bots|all","mode":"add|remove"}  (give or take a role from MANY members at once, e.g. "give every human the Players role")',
    sanitize(item) {
      const role = cleanText(item?.role, 60);
      const audience = ['humans', 'bots', 'all'].includes(String(item?.audience)) ? String(item.audience) : null;
      const mode = String(item?.mode).toLowerCase() === 'remove' ? 'remove' : 'add';
      if (!role) return 'bulk role: no role named';
      if (!audience) return 'bulk role: say who gets it (humans, bots or all)';
      return { type: 'bulk_role', role, audience, mode, count: null };
    },
    describe: (a) =>
      `👥 ${a.mode === 'add' ? 'Give' : 'Remove'} role ${a.role} ${a.mode === 'add' ? 'to' : 'from'} ${a.audience === 'all' ? 'all members' : `all ${a.audience}`}${a.count != null ? ` (${a.count} member(s))` : ''}`,
    async validate(a, env) {
      if ((env.guild.memberCount ?? 0) > MAX_BULK_GUILD_SIZE) return `bulk role: the server is too large for one run (max ${MAX_BULK_GUILD_SIZE} members)`;
      const { role, problem } = roleProblem(a, env, 'bulk role');
      if (problem) return problem;
      if (role) {
        const targets = await this.targets(a, env, role);
        if (!targets.length) return 'bulk role: nobody needs this change';
        a.count = targets.length;
      }
      return null;
    },
    async targets(a, env, role) {
      const members = await env.guild.members.fetch();
      return [...members.values()].filter((m) => {
        if (a.audience === 'humans' && m.user.bot) return false;
        if (a.audience === 'bots' && !m.user.bot) return false;
        const has = m.roles.cache.has(role.id);
        return a.mode === 'add' ? !has : has;
      });
    },
    async run(a, env) {
      const role = findRole(env.guild, a.role);
      if (!role) throw new Error(`no role called "${a.role}"`);
      const all = await this.targets(a, env, role);
      const targets = all.slice(0, MAX_BULK_MEMBERS);
      let done = 0;
      let failed = 0;
      for (const [index, member] of targets.entries()) {
        try {
          await member.roles[a.mode](role, `AI action requested by ${env.invoker.user.tag}`);
          done++;
        } catch {
          failed++;
        }
        env.progress?.(`👥 Updating roles… ${index + 1}/${targets.length}`);
      }
      const rest = all.length - targets.length;
      return `${a.mode === 'add' ? 'Gave' : 'Removed'} role ${role.name} ${a.mode === 'add' ? 'to' : 'from'} ${done} member(s)${failed ? `, ${failed} failed (role order or hierarchy)` : ''}${rest > 0 ? `; ${rest} more remain — run it again` : ''}`;
    },
  },

  move_channel: {
    permission: [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
    risky: false,
    prompt: '{"type":"move_channel","channel":"<id or name from channels>","category":"category name or null for none"}',
    sanitize(item) {
      const channel = cleanText(item?.channel, 100);
      return channel ? { type: 'move_channel', channel, category: cleanText(item?.category, 60) || null } : 'move channel: no channel named';
    },
    describe: (a) => `📦 Move ${a.channel} → ${a.category ?? 'no category'}`,
    async validate(a, env) {
      const found = findChannel(env.guild, a.channel);
      if (found.error) return `move channel: ${found.error}`;
      if (found.channel.type === ChannelType.GuildCategory) return 'move channel: categories cannot be moved into categories';
      if (!found.channel.manageable) return `move channel: I cannot edit #${found.channel.name}`;
      return null;
    },
    async run(a, env) {
      const { channel } = findChannel(env.guild, a.channel);
      const parent = a.category ? await resolveCategory(env.guild, a.category, env.categoriesMade) : null;
      await channel.setParent(parent, { lockPermissions: false, reason: `AI action requested by ${env.invoker.user.tag}` });
      return `Moved ${channel.name} → ${a.category ?? 'no category'}`;
    },
  },

  set_topic: {
    permission: [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
    risky: false,
    prompt: '{"type":"set_topic","channel":"<id or name from channels>","topic":"short description"}',
    sanitize(item) {
      const channel = cleanText(item?.channel, 100);
      const topic = cleanText(item?.topic, 500);
      return channel && topic ? { type: 'set_topic', channel, topic } : 'topic: need a channel and a topic';
    },
    describe: (a) => `📝 Set topic of ${a.channel}`,
    async validate(a, env) {
      const found = findChannel(env.guild, a.channel);
      if (found.error) return `topic: ${found.error}`;
      if (typeof found.channel.setTopic !== 'function') return `topic: #${found.channel.name} has no topic`;
      return null;
    },
    async run(a, env) {
      const { channel } = findChannel(env.guild, a.channel);
      await channel.setTopic(a.topic, `AI action requested by ${env.invoker.user.tag}`);
      return `Updated the topic of ${channel.name}`;
    },
  },

  set_channel_access: {
    permission: [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
    risky: true, // hiding an existing channel from members is a sensitive permission change
    prompt: '{"type":"set_channel_access","channel":"<id or name from channels>","access":"private|public","allowedRoles":["role names"]}  (private = hidden from @everyone, visible to the roles; public = visible again. Only visibility changes, chat is never locked.)',
    sanitize(item) {
      const channel = cleanText(item?.channel, 100);
      const access = String(item?.access).toLowerCase() === 'public' ? 'public' : String(item?.access).toLowerCase() === 'private' ? 'private' : null;
      if (!channel || !access) return 'channel access: need a channel and private/public';
      const allowedRoles = (Array.isArray(item?.allowedRoles) ? item.allowedRoles : []).map((r) => cleanText(r, 60)).filter(Boolean).slice(0, 8);
      return { type: 'set_channel_access', channel, access, allowedRoles };
    },
    describe: (a) => (a.access === 'private'
      ? `🔒 Make ${a.channel} private${a.allowedRoles.length ? ` for ${a.allowedRoles.join(', ')}` : ''}`
      : `🌐 Make ${a.channel} visible to everyone`),
    async validate(a, env) {
      const found = findChannel(env.guild, a.channel);
      if (found.error) return `channel access: ${found.error}`;
      if (!found.channel.manageable) return `channel access: I cannot edit #${found.channel.name}`;
      return null;
    },
    async run(a, env) {
      const { channel } = findChannel(env.guild, a.channel);
      const reason = `AI action requested by ${env.invoker.user.tag}`;
      const edit = (id, perms) => channel.permissionOverwrites.edit(id, perms, { reason });
      if (a.access === 'private') {
        await edit(env.guild.id, { ViewChannel: false });
        await edit(env.invoker.id, { ViewChannel: true });
        await edit(env.client.user.id, { ViewChannel: true });
        for (const id of findRoleIds(env.guild, a.allowedRoles)) await edit(id, { ViewChannel: true });
        return `Made ${channel.name} private`;
      }
      await edit(env.guild.id, { ViewChannel: null });
      return `Made ${channel.name} visible to everyone again`;
    },
  },

  set_nickname: {
    permission: [PermissionFlagsBits.ManageNicknames, 'Manage Nicknames'],
    risky: false,
    prompt: '{"type":"set_nickname","userId":"<id from mentionedUsers>","nickname":"new nickname or null to reset"}',
    sanitize(item, ctx) {
      const userId = mentioned(item, ctx);
      if (!userId) return 'nickname: that user was not mentioned in your message';
      return { type: 'set_nickname', userId, nickname: cleanText(item?.nickname, 32) || null };
    },
    describe: (a) => `🏷️ ${a.nickname ? `Set nickname of <@${a.userId}> to ${a.nickname}` : `Reset nickname of <@${a.userId}>`}`,
    async validate(a, env) {
      const member = await env.guild.members.fetch(a.userId).catch(() => null);
      if (!member) return 'nickname: that person is not in the server';
      if (!member.manageable) return 'nickname: I cannot change that member (their role is above mine)';
      if (member.id !== env.invoker.id && !outranksMember(env.invoker, member)) return 'nickname: that member is not below your highest role';
      return null;
    },
    async run(a, env) {
      const member = await fetchMember(env, a.userId);
      await member.setNickname(a.nickname, `AI action requested by ${env.invoker.user.tag}`);
      return a.nickname ? `Set nickname of <@${a.userId}> to ${a.nickname}` : `Reset nickname of <@${a.userId}>`;
    },
  },

  voice_move: {
    permission: [PermissionFlagsBits.MoveMembers, 'Move Members'],
    risky: false,
    prompt: '{"type":"voice_move","userId":"<id from mentionedUsers>","channel":"<voice channel id or name>"}',
    sanitize(item, ctx) {
      const userId = mentioned(item, ctx);
      const channel = cleanText(item?.channel, 100);
      if (!userId) return 'voice move: that user was not mentioned in your message';
      return channel ? { type: 'voice_move', userId, channel } : 'voice move: no voice channel named';
    },
    describe: (a) => `🔀 Move <@${a.userId}> to ${a.channel}`,
    async validate(a, env) {
      const found = findChannel(env.guild, a.channel);
      if (found.error) return `voice move: ${found.error}`;
      if (!isVoiceLike(found.channel)) return `voice move: #${found.channel.name} is not a voice channel`;
      const member = await env.guild.members.fetch(a.userId).catch(() => null);
      if (!member) return 'voice move: that person is not in the server';
      if (!member.voice?.channel) return 'voice move: that member is not in a voice channel';
      if (!found.channel.permissionsFor?.(env.guild.members.me)?.has(PermissionFlagsBits.Connect)) return `voice move: I cannot connect to ${found.channel.name}`;
      return null;
    },
    async run(a, env) {
      const { channel } = findChannel(env.guild, a.channel);
      const member = await fetchMember(env, a.userId);
      await member.voice.setChannel(channel, `AI action requested by ${env.invoker.user.tag}`);
      return `Moved <@${a.userId}> to ${channel.name}`;
    },
  },

  voice_disconnect: {
    permission: [PermissionFlagsBits.MoveMembers, 'Move Members'],
    risky: false,
    prompt: '{"type":"voice_disconnect","userId":"<id from mentionedUsers>"}',
    sanitize(item, ctx) {
      const userId = mentioned(item, ctx);
      return userId ? { type: 'voice_disconnect', userId } : 'voice disconnect: that user was not mentioned in your message';
    },
    describe: (a) => `🔌 Disconnect <@${a.userId}> from voice`,
    async validate(a, env) {
      const member = await env.guild.members.fetch(a.userId).catch(() => null);
      if (!member) return 'voice disconnect: that person is not in the server';
      if (!member.voice?.channel) return 'voice disconnect: that member is not in a voice channel';
      if (member.id !== env.invoker.id && !outranksMember(env.invoker, member)) return 'voice disconnect: that member is not below your highest role';
      return null;
    },
    async run(a, env) {
      const member = await fetchMember(env, a.userId);
      await member.voice.disconnect(`AI action requested by ${env.invoker.user.tag}`);
      return `Disconnected <@${a.userId}> from voice`;
    },
  },

  create_event: {
    permission: [PermissionFlagsBits.ManageEvents, 'Manage Events'],
    risky: false,
    prompt: '{"type":"create_event","name":"short title","description":"short text","startsInMinutes":120,"startsAt":"ISO 8601 with UTC offset or null","durationMinutes":60,"channel":"voice/stage channel name or null","location":"text location if no voice channel or null"}  (use startsInMinutes when the time is relative; otherwise startsAt)',
    sanitize(item) {
      const name = cleanText(item?.name, 100);
      if (!name) return 'event: no title';
      const relative = Number(item?.startsInMinutes);
      const absolute = Date.parse(String(item?.startsAt ?? ''));
      const startMs = Number.isFinite(relative) && relative > 0 ? Date.now() + relative * 60000 : absolute;
      if (!Number.isFinite(startMs)) return 'event: I could not work out the start time';
      if (startMs < Date.now() + 60000) return 'event: the start time must be in the future';
      if (startMs > Date.now() + 365 * 86400000) return 'event: the start time is more than a year away';
      const duration = Math.min(Math.max(Math.round(Number(item?.durationMinutes)) || 60, 5), 1440);
      return {
        type: 'create_event',
        name,
        description: cleanText(item?.description, 1000),
        startMs,
        endMs: startMs + duration * 60000,
        channel: cleanText(item?.channel, 100) || null,
        location: cleanText(item?.location, 100) || null,
      };
    },
    describe: (a) => `📅 Event "${a.name}" at <t:${Math.floor(a.startMs / 1000)}:F>${a.channel ? ` in ${a.channel}` : a.location ? ` (${a.location})` : ''}`,
    async validate(a, env) {
      if (!a.channel) return null;
      const found = findChannel(env.guild, a.channel);
      if (found.error) return `event: ${found.error}`;
      if (!isVoiceLike(found.channel)) return `event: #${found.channel.name} is not a voice or stage channel`;
      return null;
    },
    async run(a, env) {
      const reason = `AI action requested by ${env.invoker.user.tag}`;
      const base = {
        name: a.name,
        ...(a.description ? { description: a.description } : {}),
        scheduledStartTime: new Date(a.startMs),
        scheduledEndTime: new Date(a.endMs),
        privacyLevel: SCHEDULED_EVENT.guildOnly,
        reason,
      };
      let event;
      if (a.channel) {
        const { channel } = findChannel(env.guild, a.channel);
        event = await env.guild.scheduledEvents.create({
          ...base,
          entityType: channel.type === ChannelType.GuildStageVoice ? SCHEDULED_EVENT.stage : SCHEDULED_EVENT.voice,
          channel: channel.id,
        });
      } else {
        event = await env.guild.scheduledEvents.create({
          ...base,
          entityType: SCHEDULED_EVENT.external,
          entityMetadata: { location: a.location || 'Discord server' },
        });
      }
      return `Created event **${a.name}** for <t:${Math.floor(a.startMs / 1000)}:F>${event?.url ? ` — [open](${event.url})` : ''}`;
    },
  },

  audit_server: {
    permission: [PermissionFlagsBits.ManageGuild, 'Manage Server'],
    botPermission: false, // read-only, the bot needs no special permission
    risky: false,
    prompt: '{"type":"audit_server"}  (read-only security and configuration audit: dangerous permissions, exposed staff channels, missing settings)',
    sanitize: () => ({ type: 'audit_server' }),
    describe: () => '🔍 Audit the server',
    async run(a, env) {
      return `**Server audit**\n${formatAudit(auditGuild(env.guild))}`;
    },
  },

  server_report: {
    permission: [PermissionFlagsBits.ManageGuild, 'Manage Server'],
    botPermission: false,
    risky: false,
    prompt: '{"type":"server_report"}  (read-only statistics: members, bots, channels, roles, newest members)',
    sanitize: () => ({ type: 'server_report' }),
    describe: () => '📊 Server report',
    async run(a, env) {
      const members = (env.guild.memberCount ?? 0) <= MAX_REPORT_FETCH ? await env.guild.members.fetch().catch(() => null) : null;
      return `**Server report**\n${reportGuild(env.guild, members)}`;
    },
  },
};
