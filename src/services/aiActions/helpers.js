// Shared helpers for the AI action registry (text cleaning, lookups, safety guards).

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { normalizeName, composeCategoryName } from '../aiServerSetupService.js';

export const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}️?(?:‍\p{Extended_Pictographic}️?)*)$/u;

export function cleanText(value, max) {
  return String(value ?? '')
    .replace(/@(everyone|here)/gi, '')
    .replace(/[<>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function cleanEmoji(value, fallback = null) {
  const emoji = String(value ?? '').trim();
  return EMOJI_ONLY.test(emoji) ? emoji : fallback;
}

export function cleanRoleList(value) {
  return (Array.isArray(value) ? value : []).map((r) => cleanText(r, 60)).filter(Boolean).slice(0, 8);
}

/** Roles with these permissions can only be handed out by an Administrator/owner (no privilege escalation). */
export const POWERFUL_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.MentionEveryone,
];

export function isPowerfulRole(role) {
  return POWERFUL_PERMISSIONS.some((flag) => role.permissions?.has(flag));
}

/** Find a role by ID or by (normalized) name. @everyone and managed roles are never returned. */
export function findRole(guild, ref) {
  const wanted = String(ref ?? '').trim();
  const key = normalizeName(wanted);
  if (!key) return null;
  return (
    [...guild.roles.cache.values()].find(
      (r) => r.id !== guild.id && !r.managed && (r.id === wanted || normalizeName(r.name) === key),
    ) ?? null
  );
}

export function findRoleIds(guild, names) {
  return names.map((n) => findRole(guild, n)?.id).filter(Boolean);
}

/** Returns { channel } or { error } (not found / ambiguous). */
export function findChannel(guild, ref) {
  const wanted = String(ref ?? '').trim();
  const key = normalizeName(wanted);
  if (!key) return { error: 'no channel named' };
  const all = [...guild.channels.cache.values()].filter((c) => !c.isThread?.());
  const byId = all.find((c) => c.id === wanted);
  if (byId) return { channel: byId };
  const matches = all.filter((c) => normalizeName(c.name) === key);
  if (matches.length === 1) return { channel: matches[0] };
  return { error: matches.length ? `"${wanted}" matches several channels` : `no channel called "${wanted}"` };
}

export function privateOverwrites(guild, invokerId, botId, roleIds) {
  const see = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.Connect];
  return [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: invokerId, allow: see },
    { id: botId, allow: [...see, PermissionFlagsBits.ManageChannels] },
    ...roleIds.map((id) => ({ id, allow: see })),
  ];
}

export async function resolveCategory(guild, name, made) {
  const key = normalizeName(name);
  if (!key) return null;
  const existing = [...guild.channels.cache.values()].find(
    (c) => c.type === ChannelType.GuildCategory && normalizeName(c.name) === key,
  );
  if (existing) return existing.id;
  if (made.has(key)) return made.get(key);
  const created = await guild.channels.create({
    name: composeCategoryName('📁', name),
    type: ChannelType.GuildCategory,
    reason: 'AI action (bot ping)',
  });
  made.set(key, created.id);
  return created.id;
}

/** Owner or higher than the role in the hierarchy. */
export function invokerOutranks(invoker, role) {
  if (invoker.guild?.ownerId === invoker.id) return true;
  return (invoker.roles?.highest?.position ?? -1) > role.position;
}
