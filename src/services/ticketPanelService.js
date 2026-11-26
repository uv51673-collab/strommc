// ticketPanelService.js — publishes / updates the ticket panel and its auto-created categories.

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { getGuildConfig, setGuildConfig } from './config/guildConfig.js';
import {
  buildPanelPayload,
  createTypeCategory,
  ensureTypeCategories,
  getPanelConfig,
  MAX_TICKET_TYPES,
} from '../utils/ticket/ticketPanel.js';
import { messageHasTicketPanel } from '../utils/panelStatus.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { logger } from '../utils/logger.js';

function fail(userMessage, context = {}) {
  throw createError(userMessage, ErrorTypes.VALIDATION, userMessage, context);
}

function assertBotPermissions(guild, channel) {
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    fail('I need the **Manage Channels** permission so I can create the ticket categories.');
  }
  const perms = channel.permissionsFor(me);
  const needed = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
  ];
  if (!perms?.has(needed)) {
    fail(`I need **View Channel, Send Messages, Embed Links and Attach Files** in ${channel} to post the panel.`);
  }
}

async function findExistingPanelMessage(guild, config) {
  if (!config.ticketPanelChannelId || !config.ticketPanelMessageId) return null;
  const channel = await guild.channels.fetch(config.ticketPanelChannelId).catch(() => null);
  if (!channel?.isTextBased?.()) return null;
  const message = await channel.messages.fetch(config.ticketPanelMessageId).catch(() => null);
  return message && messageHasTicketPanel(message) ? message : null;
}

/**
 * Publishes (or updates) the ticket panel.
 *   panel      — { title, description, imageUrl, color, mode, types[] }
 *   channel    — text channel to post in
 *   staffRoleId — optional role that can see every ticket
 * Returns { message, createdCategories, closedCategory }.
 */
export async function publishTicketPanel({ client, guild, channel, panel, staffRoleId = null }) {
  if (!panel.types?.length) fail('Add at least one ticket button before publishing.');
  if (panel.types.length > MAX_TICKET_TYPES) fail(`A panel can hold at most ${MAX_TICKET_TYPES} ticket buttons.`);
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    fail('The panel channel must be a text channel.');
  }

  assertBotPermissions(guild, channel);

  const config = await getGuildConfig(client, guild.id);
  const effectiveStaffRole = staffRoleId ?? config.ticketStaffRoleId ?? null;

  const createdCategories = await ensureTypeCategories(guild, panel, effectiveStaffRole);

  let closedCategory = null;
  const existingClosed = config.ticketClosedCategoryId
    ? (guild.channels.cache.get(config.ticketClosedCategoryId)
      || await guild.channels.fetch(config.ticketClosedCategoryId).catch(() => null))
    : null;
  if (existingClosed?.type === ChannelType.GuildCategory) {
    closedCategory = existingClosed;
  } else {
    closedCategory = await createTypeCategory(
      guild,
      { label: 'Closed Tickets', emoji: '🔒' },
      effectiveStaffRole,
      '🔒 Closed Tickets',
    );
  }

  const payload = await buildPanelPayload(panel);

  let message = null;
  const previous = await findExistingPanelMessage(guild, config);
  if (previous && previous.channelId === channel.id) {
    // Re-supply attachments so a replaced image doesn't keep the old file around.
    message = await previous.edit({ ...payload, attachments: [] });
  } else {
    message = await channel.send(payload);
    if (previous) await previous.delete().catch(() => {});
  }

  const next = await getGuildConfig(client, guild.id);
  next.ticketPanel = {
    title: panel.title,
    description: panel.description,
    imageUrl: panel.imageUrl || null,
    color: panel.color || null,
    mode: panel.mode,
    types: panel.types,
  };
  next.ticketPanelChannelId = channel.id;
  next.ticketPanelMessageId = message.id;
  // keep legacy keys in sync so the dashboard and older code paths still read sensible values
  next.ticketPanelMessage = panel.description;
  next.ticketButtonLabel = panel.types[0].label;
  next.ticketCategoryId = panel.types[0].categoryId;
  next.ticketClosedCategoryId = closedCategory.id;
  next.ticketStaffRoleId = effectiveStaffRole;
  if (next.maxTicketsPerUser == null) next.maxTicketsPerUser = 3;
  if (next.dmOnClose == null) next.dmOnClose = true;

  await setGuildConfig(client, guild.id, next);

  logger.info('Ticket panel published', {
    guildId: guild.id,
    channelId: channel.id,
    types: panel.types.length,
    createdCategories: createdCategories.length,
  });

  return { message, createdCategories, closedCategory };
}

/** Re-renders the live panel message from config (used by the dashboard after edits). */
export async function refreshLivePanel(client, guild, config) {
  const message = await findExistingPanelMessage(guild, config);
  if (!message) return false;
  const payload = await buildPanelPayload(getPanelConfig(config));
  await message.edit({ ...payload, attachments: [] });
  return true;
}

/** Persists a category id that had to be re-created while opening a ticket. */
export async function saveRecreatedTypeCategory(client, guildId, typeId, categoryId) {
  const config = await getGuildConfig(client, guildId);
  if (config.ticketPanel?.types) {
    const type = config.ticketPanel.types.find((t) => t.id === typeId);
    if (type) type.categoryId = categoryId;
  }
  if (typeId === 'default') config.ticketCategoryId = categoryId;
  await setGuildConfig(client, guildId, config);
}
