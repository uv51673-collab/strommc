// channelManager.js — shared helpers for channel / category creation and permission management.

import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';

export const MAX_BULK_ITEMS = 50;
export const MAX_CHANNELS_PER_CATEGORY = 50;
export const MAX_GUILD_CHANNELS = 500;

// ---------------------------------------------------------------------------
// Channel types
// ---------------------------------------------------------------------------

export const CHANNEL_TYPES = {
  text: { type: ChannelType.GuildText, label: 'Text', emoji: '💬', prefix: '#' },
  voice: { type: ChannelType.GuildVoice, label: 'Voice', emoji: '🔊', prefix: '~' },
  announcement: { type: ChannelType.GuildAnnouncement, label: 'Announcement', emoji: '📢', prefix: '!' },
  forum: { type: ChannelType.GuildForum, label: 'Forum', emoji: '🗂️', prefix: '?' },
  stage: { type: ChannelType.GuildStageVoice, label: 'Stage', emoji: '🎙️', prefix: '^' },
};

export const channelTypeChoices = Object.entries(CHANNEL_TYPES).map(([value, t]) => ({
  name: `${t.emoji} ${t.label}`,
  value,
}));

export function describeChannelType(channel) {
  if (channel.type === ChannelType.GuildCategory) return '📁 Category';
  const entry = Object.values(CHANNEL_TYPES).find((t) => t.type === channel.type);
  return entry ? `${entry.emoji} ${entry.label}` : 'Channel';
}

export const isVoiceLike = (type) => type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice;

// ---------------------------------------------------------------------------
// Permission catalogue (what the interactive editor can toggle)
// ---------------------------------------------------------------------------

const P = PermissionFlagsBits;

export const TEXT_PERMISSIONS = [
  ['ViewChannel', 'View Channel', P.ViewChannel],
  ['SendMessages', 'Send Messages', P.SendMessages],
  ['SendMessagesInThreads', 'Send Messages in Threads', P.SendMessagesInThreads],
  ['CreatePublicThreads', 'Create Public Threads', P.CreatePublicThreads],
  ['CreatePrivateThreads', 'Create Private Threads', P.CreatePrivateThreads],
  ['EmbedLinks', 'Embed Links', P.EmbedLinks],
  ['AttachFiles', 'Attach Files', P.AttachFiles],
  ['AddReactions', 'Add Reactions', P.AddReactions],
  ['UseExternalEmojis', 'Use External Emojis', P.UseExternalEmojis],
  ['UseExternalStickers', 'Use External Stickers', P.UseExternalStickers],
  ['MentionEveryone', 'Mention @everyone / @here', P.MentionEveryone],
  ['ReadMessageHistory', 'Read Message History', P.ReadMessageHistory],
  ['UseApplicationCommands', 'Use Application Commands', P.UseApplicationCommands],
  ['SendPolls', 'Create Polls', P.SendPolls],
  ['SendVoiceMessages', 'Send Voice Messages', P.SendVoiceMessages],
  ['ManageMessages', 'Manage Messages', P.ManageMessages],
  ['ManageThreads', 'Manage Threads', P.ManageThreads],
  ['SendTTSMessages', 'Send TTS Messages', P.SendTTSMessages],
].map(([key, label, bit]) => ({ key, label, bit }));

export const VOICE_AND_ADMIN_PERMISSIONS = [
  ['Connect', 'Connect', P.Connect],
  ['Speak', 'Speak', P.Speak],
  ['Stream', 'Video / Screen Share', P.Stream],
  ['UseVAD', 'Use Voice Activity', P.UseVAD],
  ['PrioritySpeaker', 'Priority Speaker', P.PrioritySpeaker],
  ['UseSoundboard', 'Use Soundboard', P.UseSoundboard],
  ['UseEmbeddedActivities', 'Use Activities', P.UseEmbeddedActivities],
  ['RequestToSpeak', 'Request to Speak (Stage)', P.RequestToSpeak],
  ['MuteMembers', 'Mute Members', P.MuteMembers],
  ['DeafenMembers', 'Deafen Members', P.DeafenMembers],
  ['MoveMembers', 'Move Members', P.MoveMembers],
  ['CreateInstantInvite', 'Create Invite', P.CreateInstantInvite],
  ['ManageChannels', 'Manage Channel', P.ManageChannels],
  ['ManageRoles', 'Manage Permissions', P.ManageRoles],
  ['ManageWebhooks', 'Manage Webhooks', P.ManageWebhooks],
].map(([key, label, bit]) => ({ key, label, bit }));

export const ALL_EDITABLE_PERMISSIONS = [...TEXT_PERMISSIONS, ...VOICE_AND_ADMIN_PERMISSIONS];
const BY_KEY = new Map(ALL_EDITABLE_PERMISSIONS.map((p) => [p.key, p]));

export function permissionLabel(key) {
  return BY_KEY.get(key)?.label || key;
}

/** 'allow' | 'deny' | 'inherit' for one permission inside a PermissionOverwrites entry. */
export function overwriteState(overwrite, key) {
  const bit = BY_KEY.get(key)?.bit;
  if (!overwrite || !bit) return 'inherit';
  if (overwrite.allow.has(bit)) return 'allow';
  if (overwrite.deny.has(bit)) return 'deny';
  return 'inherit';
}

export const STATE_ICON = { allow: '✅', deny: '❌', inherit: '➖' };

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export const PRESETS = {
  public: {
    label: 'Public',
    emoji: '🌐',
    description: 'Everyone can see and chat (inherits the category).',
  },
  read_only: {
    label: 'Read-only',
    emoji: '📖',
    description: 'Everyone can read, only the chosen role can write (rules, announcements).',
  },
  private: {
    label: 'Private',
    emoji: '🔒',
    description: 'Hidden from everyone except the chosen role(s) and admins.',
  },
  hidden: {
    label: 'Hidden',
    emoji: '🫥',
    description: 'Hidden from @everyone; no one gets access automatically.',
  },
};

export const presetChoices = Object.entries(PRESETS).map(([value, p]) => ({
  name: `${p.emoji} ${p.label}`,
  value,
}));

const WRITE_PERMS = [
  P.SendMessages,
  P.SendMessagesInThreads,
  P.CreatePublicThreads,
  P.CreatePrivateThreads,
  P.AddReactions,
];

const FULL_ACCESS_TEXT = [
  P.ViewChannel,
  P.SendMessages,
  P.SendMessagesInThreads,
  P.ReadMessageHistory,
  P.EmbedLinks,
  P.AttachFiles,
  P.AddReactions,
  P.UseApplicationCommands,
];

const FULL_ACCESS_VOICE = [
  P.ViewChannel,
  P.Connect,
  P.Speak,
  P.Stream,
  P.UseVAD,
  P.UseApplicationCommands,
];

function botOverwrite(guild) {
  const me = guild.members.me;
  if (!me) return null;
  return {
    id: me.id,
    allow: [
      P.ViewChannel,
      P.SendMessages,
      P.ManageChannels,
      P.ManageMessages,
      P.EmbedLinks,
      P.AttachFiles,
      P.ReadMessageHistory,
      P.Connect,
    ],
  };
}

/**
 * Permission overwrites for a preset.
 *   channelType — a ChannelType value (voice channels use Connect/Speak instead of Send Messages)
 *   roleIds     — roles that get access (private) or write access (read_only)
 * Returns an array usable as `permissionOverwrites` when creating a channel.
 */
export function buildPresetOverwrites(guild, preset, { channelType = ChannelType.GuildText, roleIds = [] } = {}) {
  const everyone = guild.roles.everyone.id;
  const voice = isVoiceLike(channelType);
  const access = voice ? FULL_ACCESS_VOICE : FULL_ACCESS_TEXT;

  switch (preset) {
    case 'read_only': {
      const overwrites = [{
        id: everyone,
        allow: [P.ViewChannel, P.ReadMessageHistory],
        deny: voice ? [P.Speak] : WRITE_PERMS,
      }];
      roleIds.forEach((id) => overwrites.push({ id, allow: access }));
      const bot = botOverwrite(guild);
      if (bot) overwrites.push(bot);
      return overwrites;
    }
    case 'private':
    case 'hidden': {
      const overwrites = [{ id: everyone, deny: [P.ViewChannel] }];
      if (preset === 'private') roleIds.forEach((id) => overwrites.push({ id, allow: access }));
      const bot = botOverwrite(guild);
      if (bot) overwrites.push(bot);
      return overwrites;
    }
    case 'public':
    default:
      return [];
  }
}

/** Applies a preset to an existing channel, replacing its overwrites. */
export async function applyPresetToChannel(guild, channel, preset, { roleIds = [], reason } = {}) {
  const overwrites = buildPresetOverwrites(guild, preset, { channelType: channel.type, roleIds });
  await channel.permissionOverwrites.set(overwrites, reason);
  return overwrites;
}

// ---------------------------------------------------------------------------
// Safety checks
// ---------------------------------------------------------------------------

export function isAdminLike(member) {
  return member.id === member.guild.ownerId || member.permissions.has(P.Administrator);
}

/** Why the bot can't manage channels / overwrites (or null if it can). */
export function botPermissionProblem(guild, { needsRoles = false } = {}) {
  const me = guild.members.me;
  if (!me) return 'I could not load my own member data. Please try again.';
  if (!me.permissions.has(P.ManageChannels)) return 'I need the **Manage Channels** permission.';
  if (needsRoles && !me.permissions.has(P.ManageRoles)) return 'I need the **Manage Roles** permission to edit channel permissions.';
  return null;
}

/** Roles above the executor's highest role cannot be touched by them (owner/admin bypass is not given). */
export function canManageRole(executor, role) {
  if (executor.id === executor.guild.ownerId) return true;
  if (role.id === executor.guild.id) return true; // @everyone
  return executor.roles.highest.position > role.position;
}

export function canManageMember(executor, targetMember) {
  if (executor.id === executor.guild.ownerId) return true;
  if (targetMember.id === executor.guild.ownerId) return false;
  return executor.roles.highest.position > targetMember.roles.highest.position;
}

/** Roles the bot cannot reference in overwrites because they sit above its own role are fine for Discord, but warn. */
export function roleAboveBot(guild, role) {
  const me = guild.members.me;
  return Boolean(me && role.id !== guild.id && role.position >= me.roles.highest.position);
}

/**
 * Privilege-escalation guard: an executor may only ALLOW permissions they hold themselves in that channel
 * (Administrator / owner bypass this). Denying/resetting is always allowed.
 */
export function filterGrantablePermissions(executor, channel, keys) {
  if (isAdminLike(executor)) return { allowed: keys, blocked: [] };
  const mine = channel.permissionsFor(executor) || new PermissionsBitField();
  const allowed = [];
  const blocked = [];
  for (const key of keys) {
    const bit = BY_KEY.get(key)?.bit;
    if (bit && mine.has(bit)) allowed.push(key);
    else blocked.push(key);
  }
  return { allowed, blocked };
}

export function guildChannelRoom(guild, extra = 1) {
  return guild.channels.cache.size + extra <= MAX_GUILD_CHANNELS;
}

export function categoryRoom(category, extra = 1) {
  return !category || category.children.cache.size + extra <= MAX_CHANNELS_PER_CATEGORY;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Discord-style channel name for text-like channels; voice/category/stage keep their casing and spaces. */
export function formatChannelName(raw, type) {
  const text = String(raw ?? '').trim();
  if (type === ChannelType.GuildCategory || isVoiceLike(type)) return text.slice(0, 100);
  return text
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\p{Extended_Pictographic}_\-️‍]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

// ---------------------------------------------------------------------------
// Bulk layout parser
// ---------------------------------------------------------------------------

/**
 * Parses a text layout into categories + channels.
 *   > Information            -> category
 *   # rules                  -> text channel     ~ Lounge -> voice
 *   ! announcements          -> announcement     ? suggestions -> forum     ^ Town Hall -> stage
 * Channels belong to the closest category above them. Blank lines and `//` comments are ignored.
 * Returns { items: [{kind, name, type?, categoryIndex}], errors: [] }.
 */
export function parseLayout(input) {
  const items = [];
  const errors = [];
  let currentCategory = null;

  const byPrefix = new Map(Object.entries(CHANNEL_TYPES).map(([key, t]) => [t.prefix, key]));

  String(input ?? '').split(/\r?\n/).forEach((line, index) => {
    const text = line.trim();
    if (!text || text.startsWith('//')) return;

    const marker = text[0];
    const name = text.slice(1).trim();

    if (marker === '>') {
      if (!name) {
        errors.push(`Line ${index + 1}: category needs a name.`);
        return;
      }
      currentCategory = items.length;
      items.push({ kind: 'category', name: formatChannelName(name, ChannelType.GuildCategory) });
      return;
    }

    const typeKey = byPrefix.get(marker);
    if (!typeKey) {
      errors.push(`Line ${index + 1}: start with \`>\` (category), \`#\` text, \`~\` voice, \`!\` announcement, \`?\` forum or \`^\` stage.`);
      return;
    }
    const type = CHANNEL_TYPES[typeKey].type;
    const formatted = formatChannelName(name, type);
    if (!formatted) {
      errors.push(`Line ${index + 1}: channel needs a valid name.`);
      return;
    }
    items.push({ kind: 'channel', typeKey, type, name: formatted, categoryIndex: currentCategory });
  });

  return { items, errors };
}
