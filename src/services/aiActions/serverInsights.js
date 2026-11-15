// serverInsights.js — read-only analysis of a guild: security/config audit and a statistics report.
// Pure functions over the discord.js cache (no writes), so they are safe to run any time.

import { ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { normalizeName } from '../aiServerSetupService.js';

const POWERFUL = [
  [P.Administrator, 'Administrator'],
  [P.ManageGuild, 'Manage Server'],
  [P.ManageRoles, 'Manage Roles'],
  [P.ManageChannels, 'Manage Channels'],
  [P.KickMembers, 'Kick Members'],
  [P.BanMembers, 'Ban Members'],
  [P.ManageWebhooks, 'Manage Webhooks'],
  [P.MentionEveryone, 'Mention Everyone'],
];
const BOT_NEEDS = [
  [P.ManageChannels, 'Manage Channels'],
  [P.ManageRoles, 'Manage Roles'],
  [P.KickMembers, 'Kick Members'],
  [P.BanMembers, 'Ban Members'],
  [P.ModerateMembers, 'Timeout Members'],
  [P.ManageMessages, 'Manage Messages'],
  [P.ManageNicknames, 'Manage Nicknames'],
  [P.MoveMembers, 'Move Members'],
  [P.ManageEvents, 'Manage Events'],
];
const SENSITIVE_NAME = /(staff|mod|admin|log|private|owner)/i;
const isVoice = (c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice;

const list = (names, max = 6) =>
  names.slice(0, max).join(', ') + (names.length > max ? ` … +${names.length - max} more` : '');

/** Returns [{ level: 'high'|'medium'|'info', text }] */
export function auditGuild(guild) {
  const findings = [];
  const add = (level, text) => findings.push({ level, text });

  const everyone = guild.roles.cache.get(guild.id);
  const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id);
  const humanRoles = roles.filter((r) => !r.managed);
  const channels = [...guild.channels.cache.values()].filter((c) => !c.isThread?.());

  // @everyone must not hold powerful permissions
  const everyonePowerful = POWERFUL.filter(([flag]) => everyone?.permissions?.has(flag)).map(([, n]) => n);
  if (everyonePowerful.length) add('high', `@everyone has powerful permissions: ${everyonePowerful.join(', ')}`);

  // Administrator roles
  const adminRoles = humanRoles.filter((r) => r.permissions?.has(P.Administrator)).map((r) => r.name);
  if (adminRoles.length) {
    add(adminRoles.length > 2 ? 'medium' : 'info', `Roles with Administrator (${adminRoles.length}): ${list(adminRoles)}. Prefer specific permissions.`);
  }

  // Other powerful roles
  const powerRoles = humanRoles
    .filter((r) => !r.permissions?.has(P.Administrator) && POWERFUL.some(([flag]) => r.permissions?.has(flag)))
    .map((r) => r.name);
  if (powerRoles.length) add('info', `Roles with powerful permissions (Manage/Kick/Ban…): ${list(powerRoles)}`);

  // Sensitive channels visible to everyone
  const exposed = channels
    .filter((c) => c.type !== ChannelType.GuildCategory && SENSITIVE_NAME.test(c.name))
    .filter((c) => c.permissionsFor?.(everyone)?.has(P.ViewChannel))
    .map((c) => `#${c.name}`);
  if (exposed.length) add('high', `Staff/log-looking channels visible to @everyone: ${list(exposed)}`);

  // Roles the bot cannot manage
  const botTop = guild.members.me?.roles?.highest?.position ?? 0;
  const above = humanRoles.filter((r) => r.position >= botTop).map((r) => r.name);
  if (above.length) add('info', `Roles at or above my highest role (I cannot manage them): ${list(above)}`);

  // Bot permissions
  const botPerms = guild.members.me?.permissions;
  const missing = BOT_NEEDS.filter(([flag]) => !botPerms?.has(flag)).map(([, n]) => n);
  if (missing.length && !botPerms?.has(P.Administrator)) add('medium', `I am missing permissions: ${missing.join(', ')}`);

  // Structure
  const categories = channels.filter((c) => c.type === ChannelType.GuildCategory);
  const empty = categories.filter((cat) => !channels.some((c) => c.parentId === cat.id)).map((c) => c.name);
  if (empty.length) add('info', `Empty categories: ${list(empty)}`);
  const loose = channels.filter((c) => c.type !== ChannelType.GuildCategory && !c.parentId);
  if (loose.length > 3) add('info', `${loose.length} channels are not inside any category`);
  const seen = new Map();
  for (const c of channels.filter((x) => x.type !== ChannelType.GuildCategory)) {
    const key = `${isVoice(c) ? 'v' : 't'}:${normalizeName(c.name)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k.slice(2));
  if (dupes.length) add('info', `Duplicate channel names: ${list(dupes)}`);

  // Server settings
  if (guild.verificationLevel === 0) add('medium', 'Verification level is None: anyone can join and talk instantly');
  if (guild.mfaLevel === 0 && adminRoles.length) add('medium', 'Two-factor authentication is not required for moderators');
  if (!guild.rulesChannelId) add('info', 'No rules channel is set in Server Settings');
  if (!guild.systemChannelId) add('info', 'No system messages channel is set');

  return findings;
}

export function formatAudit(findings) {
  if (!findings.length) return '✅ No problems found. Permissions and structure look healthy.';
  const icon = { high: '🔴', medium: '🟡', info: 'ℹ️' };
  const order = { high: 0, medium: 1, info: 2 };
  const sorted = [...findings].sort((a, b) => order[a.level] - order[b.level]);
  const counts = ['high', 'medium', 'info'].map((l) => `${icon[l]} ${findings.filter((f) => f.level === l).length}`).join(' · ');
  return `${counts}\n\n${sorted.map((f) => `${icon[f.level]} ${f.text}`).join('\n')}`.slice(0, 3800);
}

/** Statistics report. `members` is the (optionally fully fetched) member collection or null. */
export function reportGuild(guild, members = null) {
  const channels = [...guild.channels.cache.values()].filter((c) => !c.isThread?.());
  const by = (pred) => channels.filter(pred).length;
  const lines = [];

  const total = guild.memberCount ?? members?.size ?? 0;
  if (members && members.size) {
    const list = [...members.values()];
    const bots = list.filter((m) => m.user?.bot).length;
    lines.push(`👥 **Members:** ${total} (${list.length - bots} humans, ${bots} bots)`);
  } else {
    lines.push(`👥 **Members:** ${total}`);
  }
  lines.push(`💬 **Channels:** ${by((c) => c.type !== ChannelType.GuildCategory)} total — ${by((c) => c.type === ChannelType.GuildText)} text, ${by(isVoice)} voice, ${by((c) => c.type === ChannelType.GuildForum)} forum, ${by((c) => c.type === ChannelType.GuildAnnouncement)} announcement · 📁 ${by((c) => c.type === ChannelType.GuildCategory)} categories`);

  const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id);
  lines.push(`🎭 **Roles:** ${roles.length}`);
  if (members && members.size) {
    const top = roles
      .map((r) => [r.name, [...members.values()].filter((m) => m.roles.cache.has(r.id)).length])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, n]) => `${name} (${n})`);
    if (top.length) lines.push(`📊 **Biggest roles:** ${top.join(', ')}`);
    const newest = [...members.values()]
      .filter((m) => m.joinedTimestamp)
      .sort((a, b) => b.joinedTimestamp - a.joinedTimestamp)
      .slice(0, 10)
      .map((m) => `<@${m.id}>`);
    if (newest.length) lines.push(`🆕 **Newest members:** ${newest.join(' ')}`);
  } else {
    lines.push('ℹ️ Member breakdown is not available for a server this large.');
  }
  if (guild.premiumSubscriptionCount != null) lines.push(`🚀 **Boosts:** ${guild.premiumSubscriptionCount} (tier ${guild.premiumTier ?? 0})`);
  if (guild.createdTimestamp) lines.push(`📅 **Created:** <t:${Math.floor(guild.createdTimestamp / 1000)}:D>`);
  return lines.join('\n');
}
