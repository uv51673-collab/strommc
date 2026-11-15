// aiServerSetupService.js — plans and builds a server layout (categories + text/voice
// channels with emojis) using Gemini. Used by /aisetup.
//
// Flow: collect server context -> ask Gemini for a JSON plan -> sanitize/validate the plan
// (never trust model output) -> preview -> create channels one by one, reporting progress.

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { askGemini } from './geminiService.js';
import { logger } from '../utils/logger.js';

export const LIMITS = {
  maxCategories: 10,
  maxChannelsPerCategory: 12,
  maxTotalChannels: 50,
  guildChannelCap: 500,
  categoryChannelCap: 50,
  maxRequestLength: 400,
};

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}️?(?:‍\p{Extended_Pictographic}️?)*)$/u;
const DEFAULT_CATEGORY_EMOJI = '📁';
const DEFAULT_TEXT_EMOJI = '💬';
const DEFAULT_VOICE_EMOJI = '🔊';

const SYSTEM_INSTRUCTION = [
  'You are a senior Discord community architect. You design professional server layouts. Reply with JSON only, no markdown.',
  'Schema: {"categories":[{"name":"INFO","emoji":"📢","private":false,"allowedRoles":[],"channels":[{"name":"rules","type":"text","emoji":"📜","topic":"short topic"},{"name":"General","type":"voice","emoji":"🔊"}]}]}',
  'Rules: pick ONE fitting emoji per category and per channel yourself (a single emoji character, no text).',
  'Category names are short plain words (1-3 words). Text channel names are lowercase words, hyphens allowed.',
  'Voice channel names are short Title Case words. "type" is "text" or "voice".',
  'Size: follow the number the owner asks for (default about 30 channels). Hard limits: 10 categories, 12 channels per category, 50 channels in total.',
  'Layout, in this order and adapted to the request: START HERE / INFO (welcome, rules, announcements, faq, roles), COMMUNITY (general chat, media, memes, bot-commands, suggestions),',
  'the theme sections that fit the request (for example gaming, study, music, trading, art), SUPPORT (help, tickets, report), VOICE LOUNGES (several voice rooms: general, gaming, music, chill, study, AFK),',
  'EVENTS / GIVEAWAYS if it fits, and a STAFF category with "private": true and "allowedRoles" set to staff-like role names from the server context (staff-chat, mod-logs, admin, voice).',
  'Only mark a category private when it is clearly for staff. Never make channels read-only and never restrict chatting in public channels.',
  'Do not repeat categories or channels that already exist (see the server context). Never use @everyone or @here.',
].join('\n');

/** Lowercase letters/digits only, so "📢 INFO" and "info" compare equal. */
export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{Extended_Pictographic}|️|‍/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();
}

function cleanEmoji(value, fallback) {
  const emoji = String(value ?? '').trim();
  return EMOJI_ONLY.test(emoji) ? emoji : fallback;
}

function cleanWords(value, maxLength) {
  return String(value ?? '')
    .replace(/\p{Extended_Pictographic}|️|‍/gu, '')
    .replace(/@(everyone|here)/gi, '')
    .replace(/[<>@#`*_~|\\]/g, '')
    .replace(/[^\p{L}\p{N} _-]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function composeCategoryName(emoji, name) {
  return `${emoji} ${name.toUpperCase()}`.slice(0, 100);
}

export function composeTextName(emoji, name) {
  const slug = name.toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `${emoji}┃${slug}`.slice(0, 100);
}

export function composeVoiceName(emoji, name) {
  const title = name.replace(/-/g, ' ').replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  return `${emoji} ${title}`.slice(0, 100);
}

/** What the model gets to see about the server. */
export function collectContext(guild) {
  const channels = [...guild.channels.cache.values()];
  const categories = channels.filter((c) => c.type === ChannelType.GuildCategory);
  return {
    name: guild.name,
    memberCount: guild.memberCount,
    roles: [...guild.roles.cache.values()]
      .filter((r) => !r.managed && r.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .slice(0, 15)
      .map((r) => r.name),
    categories: categories.slice(0, 25).map((cat) => ({
      name: cat.name,
      channels: channels
        .filter((c) => c.parentId === cat.id)
        .slice(0, 15)
        .map((c) => `${c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice ? 'voice' : 'text'}:${c.name}`),
    })),
    uncategorized: channels
      .filter((c) => !c.parentId && c.type !== ChannelType.GuildCategory)
      .slice(0, 15)
      .map((c) => c.name),
    totalChannels: channels.length,
  };
}

function buildPrompt(request, context) {
  return [
    `Owner request: ${request}`,
    '',
    'Server context (JSON):',
    JSON.stringify(context),
  ].join('\n');
}

function parseJson(text) {
  const trimmed = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error('not json');
  }
}

/**
 * Turns raw model output into a safe plan. Pure function (no Discord calls).
 * `existing` = { categories: Map(normalizedName -> id|name), channels: Set(normalizedName), totalChannels }
 */
export function sanitizePlan(raw, existing = { categories: new Map(), channels: new Set(), totalChannels: 0 }) {
  const plan = { categories: [], skipped: [], total: 0 };
  const seenCategories = new Set();
  const seenChannels = new Set(existing.channels);
  const room = Math.max(0, LIMITS.guildChannelCap - existing.totalChannels);
  const maxTotal = Math.min(LIMITS.maxTotalChannels, room);

  const rawCategories = Array.isArray(raw?.categories) ? raw.categories : [];

  for (const rawCategory of rawCategories.slice(0, LIMITS.maxCategories * 2)) {
    if (plan.categories.length >= LIMITS.maxCategories) break;

    const name = cleanWords(rawCategory?.name, 40);
    const key = normalizeName(name);
    if (!key || seenCategories.has(key)) continue;
    seenCategories.add(key);

    const emoji = cleanEmoji(rawCategory?.emoji, DEFAULT_CATEGORY_EMOJI);
    const existingCategory = existing.categories.get(key) ?? null;

    const channels = [];
    const rawChannels = Array.isArray(rawCategory?.channels) ? rawCategory.channels : [];
    for (const rawChannel of rawChannels) {
      if (channels.length >= LIMITS.maxChannelsPerCategory) break;
      const channelName = cleanWords(rawChannel?.name, 60);
      const channelKey = normalizeName(channelName);
      if (!channelKey) continue;
      const type = String(rawChannel?.type).toLowerCase() === 'voice' ? 'voice' : 'text';
      const dedupeKey = `${type}:${channelKey}`;
      if (seenChannels.has(dedupeKey) || seenChannels.has(channelKey)) {
        plan.skipped.push(`${type === 'voice' ? 'voice' : 'text'} "${channelName}" already exists`);
        continue;
      }
      seenChannels.add(dedupeKey);
      channels.push({
        type,
        label: channelName,
        emoji: cleanEmoji(rawChannel?.emoji, type === 'voice' ? DEFAULT_VOICE_EMOJI : DEFAULT_TEXT_EMOJI),
        topic: type === 'text' ? cleanWords(rawChannel?.topic, 200) : '',
      });
    }

    if (!channels.length && existingCategory) {
      plan.skipped.push(`category "${name}" already exists`);
      continue;
    }
    if (!channels.length) continue;

    plan.categories.push({
      label: name,
      emoji,
      private: rawCategory?.private === true,
      allowedRoles: (Array.isArray(rawCategory?.allowedRoles) ? rawCategory.allowedRoles : [])
        .map((r) => cleanWords(r, 60))
        .filter(Boolean)
        .slice(0, 8),
      existingId: existingCategory,
      channels: channels.map((c) => ({
        ...c,
        name: c.type === 'voice' ? composeVoiceName(c.emoji, c.label) : composeTextName(c.emoji, c.label),
      })),
      name: composeCategoryName(emoji, name),
    });
  }

  // Enforce the total cap (and the 500-channel guild cap) by trimming from the end.
  let used = 0;
  for (const category of plan.categories) {
    const newCategorySlot = category.existingId ? 0 : 1;
    const allowed = Math.max(0, maxTotal - used - newCategorySlot);
    if (category.channels.length > allowed) {
      plan.skipped.push(`${category.channels.length - allowed} channel(s) in "${category.label}" trimmed (limit)`);
      category.channels = category.channels.slice(0, allowed);
    }
    used += category.channels.length + (category.channels.length ? newCategorySlot : 0);
  }
  plan.categories = plan.categories.filter((c) => c.channels.length > 0);
  plan.total = plan.categories.reduce((sum, c) => sum + c.channels.length + (c.existingId ? 0 : 1), 0);
  return plan;
}

function buildExisting(guild) {
  const categories = new Map();
  const channels = new Set();
  for (const channel of guild.channels.cache.values()) {
    const key = normalizeName(channel.name);
    if (channel.type === ChannelType.GuildCategory) {
      categories.set(key, channel.id);
    } else {
      const type = channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice ? 'voice' : 'text';
      channels.add(`${type}:${key}`);
    }
  }
  return { categories, channels, totalChannels: guild.channels.cache.size };
}

/** Ask Gemini and return a sanitized plan. Throws an error with `userMessage` on failure. */
export async function requestPlan(guild, request, { fresh = false } = {}) {
  // fresh = the server is about to be wiped, so plan as if it were empty.
  const context = fresh ? { name: guild.name, memberCount: guild.memberCount, roles: collectContext(guild).roles, categories: [], uncategorized: [], totalChannels: 0 } : collectContext(guild);
  const text = await askGemini(buildPrompt(request.slice(0, LIMITS.maxRequestLength), context), {
    systemInstruction: SYSTEM_INSTRUCTION,
    maxOutputTokens: 8192,
    json: true,
    maxQuestionLength: 6000,
    totalTimeoutMs: 90000,
  });

  let raw;
  try {
    raw = parseJson(text);
  } catch {
    const error = new Error('Gemini returned invalid JSON');
    error.userMessage = 'The AI did not return a usable layout. Please try again.';
    throw error;
  }

  const plan = sanitizePlan(raw, fresh ? undefined : buildExisting(guild));
  if (!plan.categories.length) {
    const error = new Error('Empty plan');
    error.userMessage = plan.skipped.length
      ? 'Everything the AI suggested already exists in this server. Try a more specific request.'
      : 'The AI did not suggest any new channels. Try describing your server in more detail.';
    throw error;
  }
  return plan;
}

/**
 * Creates the planned categories/channels one by one.
 * `onProgress(event)` is called after each step: { kind, label, status: 'ok'|'fail'|'skip', error? }
 */
export async function applyPlan(guild, plan, onProgress = () => {}, { invokerId = null, botId = null } = {}) {
  const botMember = guild.members.me;
  const results = { created: 0, failed: 0, steps: [] };

  const report = (step) => {
    results.steps.push(step);
    if (step.status === 'ok') results.created++;
    if (step.status === 'fail') results.failed++;
    return Promise.resolve(onProgress(step, results)).catch(() => {});
  };

  for (const category of plan.categories) {
    let parentId = category.existingId;
    const overwrites = category.private && !category.existingId ? privateOverwrites(guild, category, invokerId, botId) : null;

    if (!parentId) {
      try {
        const created = await guild.channels.create({
          name: category.name,
          type: ChannelType.GuildCategory,
          ...(overwrites ? { permissionOverwrites: overwrites } : {}),
          reason: 'AI server setup (/aisetup)',
        });
        parentId = created.id;
        await report({ kind: 'category', label: category.name, status: 'ok' });
      } catch (error) {
        logger.warn(`aisetup: could not create category ${category.name}: ${error?.message}`);
        await report({ kind: 'category', label: category.name, status: 'fail', error: error?.message });
        for (const channel of category.channels) {
          await report({ kind: channel.type, label: channel.name, status: 'skip', error: 'category failed' });
        }
        continue;
      }
    }

    for (const channel of category.channels) {
      try {
        await guild.channels.create({
          name: channel.name,
          type: channel.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
          parent: parentId,
          ...(overwrites ? { permissionOverwrites: overwrites } : {}),
          ...(channel.topic ? { topic: channel.topic } : {}),
          reason: 'AI server setup (/aisetup)',
        });
        await report({ kind: channel.type, label: channel.name, status: 'ok' });
      } catch (error) {
        logger.warn(`aisetup: could not create channel ${channel.name}: ${error?.message}`);
        await report({ kind: channel.type, label: channel.name, status: 'fail', error: error?.message });
      }
    }
  }

  return results;
}

export function botCanManageChannels(guild) {
  return Boolean(guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels));
}

// Staff-only categories: hidden from @everyone, visible to the named roles, the requester and the bot.
// (Hiding is not locking: nothing is made read-only.)
function privateOverwrites(guild, category, invokerId, botId) {
  const see = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.Connect];
  const roleIds = (category.allowedRoles ?? [])
    .map((wanted) => {
      const key = normalizeName(wanted);
      return [...guild.roles.cache.values()].find((r) => r.id !== guild.id && !r.managed && normalizeName(r.name) === key)?.id;
    })
    .filter(Boolean);
  return [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...(invokerId ? [{ id: invokerId, allow: see }] : []),
    ...(botId ? [{ id: botId, allow: [...see, PermissionFlagsBits.ManageChannels] }] : []),
    ...roleIds.map((id) => ({ id, allow: see })),
  ];
}

/** Text tree of a plan; statusByName marks progress (✅ ❌ ⏭️ ⏳). */
export function renderPlan(plan, statusByName = new Map(), maxLength = 3800) {
  const icon = (name) => {
    const status = statusByName.get(name);
    if (status === 'ok') return '✅';
    if (status === 'fail') return '❌';
    if (status === 'skip') return '⏭️';
    if (status === 'run') return '⏳';
    return '▫️';
  };
  const lines = [];
  for (const category of plan.categories) {
    lines.push(`${icon(category.name)} **${category.name}**${category.existingId ? ' *(existing)*' : ''}${category.private ? ' 🔒' : ''}`);
    for (const channel of category.channels) {
      const kind = channel.type === 'voice' ? '🔊' : '#️⃣';
      lines.push(`　${icon(channel.name)} ${kind} ${channel.name}`);
    }
  }
  const text = lines.join('\n');
  return text.length > maxLength ? `${text.slice(0, maxLength - 20)}\n…` : text;
}
