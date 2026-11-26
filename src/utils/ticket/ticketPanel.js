// ticketPanel.js — shared model + builders for the multi-type ticket panel.
//
// Stored in guild config as `ticketPanel`:
// {
//   title, description, imageUrl, color, mode: 'buttons' | 'dropdown',
//   types: [{ id, label, emoji, style, description, categoryId, categoryName }]
// }
// Older servers only have the legacy keys (ticketPanelMessage, ticketButtonLabel,
// ticketCategoryId); getPanelConfig() maps those to a single "default" type so they keep working.

import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import axios from 'axios';
import { getColor } from '../../config/bot.js';
import { logger } from '../logger.js';

export const MAX_TICKET_TYPES = 25; // Discord: 5 rows x 5 buttons, or 25 select options per message
export const PANEL_SELECT_ID = 'ticket_panel_select';
export const PANEL_BUTTON_PREFIX = 'create_ticket';
export const MAX_CHANNELS_PER_CATEGORY = 50;

export const DEFAULT_PANEL_TITLE = 'Support Tickets';
export const DEFAULT_PANEL_DESCRIPTION = 'Click the button below to create a support ticket.';

export const BUTTON_STYLES = {
  blue: { label: 'Blue', style: ButtonStyle.Primary, emoji: '🔵' },
  gray: { label: 'Gray', style: ButtonStyle.Secondary, emoji: '⚪' },
  green: { label: 'Green', style: ButtonStyle.Success, emoji: '🟢' },
  red: { label: 'Red', style: ButtonStyle.Danger, emoji: '🔴' },
};

const DISCORD_CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

export function newTypeId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function clip(value, max) {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function slugify(label, fallback = 'ticket') {
  const slug = String(label ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || fallback;
}

/** Unicode emoji or custom emoji (<:name:id> / <a:name:id>) -> value accepted by discord.js, or null. */
export function parseEmoji(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  const custom = text.match(/^<(a?):([A-Za-z0-9_]{2,32}):(\d{17,21})>$/);
  if (custom) return { animated: custom[1] === 'a', name: custom[2], id: custom[3] };
  // A single emoji (possibly a ZWJ sequence / flag / keycap). Reject plain text.
  if (/^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?⃣)/u.test(text) && text.length <= 16) {
    return text;
  }
  return null;
}

export function emojiToString(emoji) {
  if (!emoji) return '';
  if (typeof emoji === 'string') return emoji;
  return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
}

export function parseColor(input) {
  const text = String(input ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(text)) return `#${text.toUpperCase()}`;
  return null;
}

/** Normalised panel config (with legacy fallback). Always returns a fresh object. */
export function getPanelConfig(guildConfig = {}) {
  const stored = guildConfig.ticketPanel;
  if (stored && Array.isArray(stored.types)) {
    return {
      title: stored.title || DEFAULT_PANEL_TITLE,
      description: stored.description || guildConfig.ticketPanelMessage || DEFAULT_PANEL_DESCRIPTION,
      imageUrl: stored.imageUrl || null,
      color: stored.color || null,
      mode: stored.mode === 'dropdown' ? 'dropdown' : 'buttons',
      types: stored.types.map((t) => ({ ...t })),
    };
  }

  const hasLegacy = Boolean(guildConfig.ticketPanelChannelId);
  return {
    title: DEFAULT_PANEL_TITLE,
    description: guildConfig.ticketPanelMessage || DEFAULT_PANEL_DESCRIPTION,
    imageUrl: null,
    color: null,
    mode: 'buttons',
    types: hasLegacy
      ? [{
        id: 'default',
        label: guildConfig.ticketButtonLabel || 'Create Ticket',
        emoji: '📩',
        style: 'blue',
        description: '',
        categoryId: guildConfig.ticketCategoryId || null,
        categoryName: null,
      }]
      : [],
  };
}

export function findTicketType(guildConfig, typeId) {
  const panel = getPanelConfig(guildConfig);
  if (!typeId) return panel.types.length === 1 ? panel.types[0] : null;
  return panel.types.find((t) => t.id === typeId) || null;
}

function typeEmoji(type) {
  return parseEmoji(emojiToString(type.emoji)) || undefined;
}

export function buildPanelEmbed(panel, { imageUrl } = {}) {
  const embed = new EmbedBuilder()
    .setTitle(clip(panel.title || DEFAULT_PANEL_TITLE, 256))
    .setDescription(clip(panel.description || DEFAULT_PANEL_DESCRIPTION, 4000))
    .setColor(panel.color || getColor('info'));

  const image = imageUrl ?? panel.imageUrl;
  if (image) embed.setImage(image);
  return embed;
}

export function buildPanelComponents(panel, { disabled = false } = {}) {
  const types = (panel.types || []).slice(0, MAX_TICKET_TYPES);
  if (types.length === 0) return [];

  if (panel.mode === 'dropdown') {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(PANEL_SELECT_ID)
      .setPlaceholder('Select a ticket type…')
      .setDisabled(disabled)
      .addOptions(types.map((type) => {
        const option = new StringSelectMenuOptionBuilder()
          .setLabel(clip(type.label, 100))
          .setValue(type.id);
        if (type.description) option.setDescription(clip(type.description, 100));
        const emoji = typeEmoji(type);
        if (emoji) option.setEmoji(emoji);
        return option;
      }));
    return [new ActionRowBuilder().addComponents(menu)];
  }

  const rows = [];
  for (let i = 0; i < types.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const type of types.slice(i, i + 5)) {
      const button = new ButtonBuilder()
        .setCustomId(`${PANEL_BUTTON_PREFIX}:${type.id}`)
        .setLabel(clip(type.label, 80))
        .setStyle((BUTTON_STYLES[type.style] || BUTTON_STYLES.blue).style)
        .setDisabled(disabled);
      const emoji = typeEmoji(type);
      if (emoji) button.setEmoji(emoji);
      row.addComponents(button);
    }
    rows.push(row);
  }
  return rows;
}

function isDiscordCdnUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return DISCORD_CDN_HOSTS.has(url.hostname) && url.pathname.startsWith('/attachments/');
  } catch {
    return false;
  }
}

/**
 * Message payload for the live panel. Images uploaded through Discord are re-attached to the
 * panel message itself, because signed CDN links expire and the picture would vanish.
 * Other image URLs are used as-is (the bot never downloads arbitrary hosts).
 */
export async function buildPanelPayload(panel) {
  let imageUrl = panel.imageUrl || null;
  const files = [];

  if (imageUrl && isDiscordCdnUrl(imageUrl)) {
    try {
      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 15_000,
        maxContentLength: 8 * 1024 * 1024,
      });
      const pathname = new URL(imageUrl).pathname;
      const ext = (pathname.match(/\.(png|jpe?g|gif|webp)$/i)?.[1] || 'png').toLowerCase();
      const name = `ticket-panel.${ext}`;
      files.push(new AttachmentBuilder(Buffer.from(response.data), { name }));
      imageUrl = `attachment://${name}`;
    } catch (error) {
      logger.warn(`Could not re-attach ticket panel image, using the link instead: ${error.message}`);
    }
  }

  return {
    embeds: [buildPanelEmbed(panel, { imageUrl })],
    components: buildPanelComponents(panel),
    files,
  };
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

function categoryOverwrites(guild, staffRoleId) {
  const me = guild.members.me;
  return [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...(me ? [{
      id: me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    }] : []),
    ...(staffRoleId ? [{
      id: staffRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    }] : []),
  ];
}

async function fetchCategory(guild, id) {
  if (!id) return null;
  const channel = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
  return channel?.type === ChannelType.GuildCategory ? channel : null;
}

export function defaultCategoryName(type) {
  const emoji = typeof type.emoji === 'string' ? type.emoji : '';
  return clip(type.categoryName || `${emoji ? `${emoji} ` : ''}${type.label}`.trim(), 100);
}

/** Creates a private category for the ticket type (staff + bot only). */
export async function createTypeCategory(guild, type, staffRoleId, nameOverride = null) {
  return guild.channels.create({
    name: clip(nameOverride || defaultCategoryName(type), 100),
    type: ChannelType.GuildCategory,
    permissionOverwrites: categoryOverwrites(guild, staffRoleId),
    reason: `Ticket category for "${type.label}"`,
  });
}

/**
 * Makes sure every type has a category that still exists. Mutates `panel.types[].categoryId`.
 * Returns the categories that were created.
 */
export async function ensureTypeCategories(guild, panel, staffRoleId) {
  const created = [];
  for (const type of panel.types) {
    const existing = await fetchCategory(guild, type.categoryId);
    if (existing) continue;
    const category = await createTypeCategory(guild, type, staffRoleId);
    type.categoryId = category.id;
    created.push({ type, category });
  }
  return created;
}

/** Category where a new ticket of this type should be created, handling full (50 channel) categories. */
export async function resolveOpenCategory(guild, type, staffRoleId) {
  let category = await fetchCategory(guild, type.categoryId);
  let recreated = false;

  if (!category) {
    category = await createTypeCategory(guild, type, staffRoleId);
    recreated = true;
  }

  if (category.children.cache.size < MAX_CHANNELS_PER_CATEGORY) {
    return { category, recreated };
  }

  // Discord allows 50 channels per category: spill over into "<name> (2)", "(3)", ...
  const base = category.name.replace(/ \(\d+\)$/, '');
  for (let n = 2; n < 50; n += 1) {
    const name = clip(`${base} (${n})`, 100);
    const overflow = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name === name,
    );
    if (overflow) {
      if (overflow.children.cache.size < MAX_CHANNELS_PER_CATEGORY) return { category: overflow, recreated };
      continue;
    }
    const created = await createTypeCategory(guild, type, staffRoleId, name);
    return { category: created, recreated };
  }
  return { category, recreated };
}
