// /channel — create, organise and secure channels & categories.
//
//   create       one channel with a permission preset
//   category     a category with a permission preset
//   bulk         paste a whole server layout, preview it, then build it
//   edit         rename / topic / slowmode / NSFW / move / user limit
//   clone        duplicate a channel with all of its permissions
//   delete       delete a channel or category (with confirmation)
//   sync         re-sync a channel's permissions with its category
//   preset       apply Public / Read-only / Private / Hidden to an existing channel
//   permissions  interactive permission editor for a role or member
//   overview     see every permission overwrite on a channel

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { createEmbed, successEmbed, warningEmbed } from '../../utils/embeds.js';
import { logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { getColor } from '../../config/bot.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import {
  CHANNEL_TYPES,
  MAX_BULK_ITEMS,
  PRESETS,
  STATE_ICON,
  TEXT_PERMISSIONS,
  VOICE_AND_ADMIN_PERMISSIONS,
  applyPresetToChannel,
  botPermissionProblem,
  buildPresetOverwrites,
  canManageMember,
  canManageRole,
  categoryRoom,
  channelTypeChoices,
  describeChannelType,
  filterGrantablePermissions,
  formatChannelName,
  guildChannelRoom,
  isAdminLike,
  isVoiceLike,
  overwriteState,
  parseLayout,
  permissionLabel,
  presetChoices,
} from '../../utils/channelManager.js';

const EPHEMERAL = MessageFlags.Ephemeral;
const P = PermissionFlagsBits;

const MANAGEABLE_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildCategory,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
];

const clip = (value, max) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

const manageableChannelOption = (opt, description = 'The channel or category') => opt
  .setName('channel')
  .setDescription(description)
  .addChannelTypes(...MANAGEABLE_TYPES)
  .setRequired(true);

export default {
  category: 'Moderation',
  data: new SlashCommandBuilder()
    .setName('channel')
    .setDescription('Create, organise and secure channels, categories and permissions.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .setDMPermission(false)
    .addSubcommand((sub) => sub
      .setName('create')
      .setDescription('Create a channel with a permission preset.')
      .addStringOption((o) => o.setName('name').setDescription('Channel name').setMaxLength(100).setRequired(true))
      .addStringOption((o) => o.setName('type').setDescription('Channel type (default: text)').addChoices(...channelTypeChoices))
      .addChannelOption((o) => o.setName('category').setDescription('Category to create it in').addChannelTypes(ChannelType.GuildCategory))
      .addStringOption((o) => o.setName('preset').setDescription('Who can see / write (default: inherit from category)').addChoices(...presetChoices))
      .addRoleOption((o) => o.setName('role').setDescription('Role that gets access (private) or can write (read-only)'))
      .addRoleOption((o) => o.setName('role2').setDescription('Second role with the same access'))
      .addStringOption((o) => o.setName('topic').setDescription('Channel topic / description').setMaxLength(1024))
      .addIntegerOption((o) => o.setName('slowmode').setDescription('Slowmode in seconds (0-21600)').setMinValue(0).setMaxValue(21600))
      .addBooleanOption((o) => o.setName('nsfw').setDescription('Age-restricted channel'))
      .addIntegerOption((o) => o.setName('user_limit').setDescription('Voice user limit (0 = unlimited)').setMinValue(0).setMaxValue(99)))
    .addSubcommand((sub) => sub
      .setName('category')
      .setDescription('Create a category with a permission preset.')
      .addStringOption((o) => o.setName('name').setDescription('Category name').setMaxLength(100).setRequired(true))
      .addStringOption((o) => o.setName('preset').setDescription('Who can see it (channels inside inherit this)').addChoices(...presetChoices))
      .addRoleOption((o) => o.setName('role').setDescription('Role that gets access'))
      .addRoleOption((o) => o.setName('role2').setDescription('Second role with the same access')))
    .addSubcommand((sub) => sub
      .setName('bulk')
      .setDescription('Paste a server layout (categories + channels), preview it, then build it.')
      .addStringOption((o) => o.setName('preset').setDescription('Preset applied to every new category / loose channel').addChoices(...presetChoices))
      .addRoleOption((o) => o.setName('role').setDescription('Role that gets access (private) or can write (read-only)')))
    .addSubcommand((sub) => sub
      .setName('edit')
      .setDescription('Rename, move or change settings of a channel.')
      .addChannelOption((o) => manageableChannelOption(o))
      .addStringOption((o) => o.setName('name').setDescription('New name').setMaxLength(100))
      .addStringOption((o) => o.setName('topic').setDescription('New topic').setMaxLength(1024))
      .addIntegerOption((o) => o.setName('slowmode').setDescription('Slowmode in seconds (0-21600)').setMinValue(0).setMaxValue(21600))
      .addBooleanOption((o) => o.setName('nsfw').setDescription('Age-restricted'))
      .addChannelOption((o) => o.setName('category').setDescription('Move into this category').addChannelTypes(ChannelType.GuildCategory))
      .addIntegerOption((o) => o.setName('user_limit').setDescription('Voice user limit (0 = unlimited)').setMinValue(0).setMaxValue(99)))
    .addSubcommand((sub) => sub
      .setName('clone')
      .setDescription('Duplicate a channel, including its permissions.')
      .addChannelOption((o) => manageableChannelOption(o, 'Channel to clone'))
      .addStringOption((o) => o.setName('name').setDescription('Name for the copy').setMaxLength(100)))
    .addSubcommand((sub) => sub
      .setName('delete')
      .setDescription('Delete a channel or category (asks for confirmation).')
      .addChannelOption((o) => manageableChannelOption(o))
      .addBooleanOption((o) => o.setName('delete_children').setDescription('Categories: also delete every channel inside it')))
    .addSubcommand((sub) => sub
      .setName('sync')
      .setDescription('Re-sync a channel\'s permissions with its category.')
      .addChannelOption((o) => manageableChannelOption(o, 'Channel to sync')))
    .addSubcommand((sub) => sub
      .setName('preset')
      .setDescription('Apply Public / Read-only / Private / Hidden to an existing channel.')
      .addChannelOption((o) => manageableChannelOption(o))
      .addStringOption((o) => o.setName('preset').setDescription('Permission preset').addChoices(...presetChoices).setRequired(true))
      .addRoleOption((o) => o.setName('role').setDescription('Role that gets access (private) or can write (read-only)'))
      .addRoleOption((o) => o.setName('role2').setDescription('Second role with the same access')))
    .addSubcommand((sub) => sub
      .setName('permissions')
      .setDescription('Interactive permission editor for a role or member.')
      .addChannelOption((o) => manageableChannelOption(o))
      .addRoleOption((o) => o.setName('role').setDescription('Role to edit (default: @everyone)'))
      .addUserOption((o) => o.setName('user').setDescription('Member to edit')))
    .addSubcommand((sub) => sub
      .setName('overview')
      .setDescription('Show every permission overwrite on a channel.')
      .addChannelOption((o) => manageableChannelOption(o))),

  async execute(interaction, config, client) {
    const sub = interaction.options.getSubcommand();

    try {
      // `bulk` must open its modal as the very first response, so it can't be deferred.
      if (sub === 'bulk') return await handleBulk(interaction, client);

      const deferred = await InteractionHelper.safeDefer(interaction, { flags: EPHEMERAL });
      if (!deferred) return undefined;

      switch (sub) {
        case 'create': return await handleCreate(interaction, client);
        case 'category': return await handleCategory(interaction, client);
        case 'edit': return await handleEdit(interaction, client);
        case 'clone': return await handleClone(interaction, client);
        case 'delete': return await handleDelete(interaction, client);
        case 'sync': return await handleSync(interaction, client);
        case 'preset': return await handlePreset(interaction, client);
        case 'permissions': return await handlePermissions(interaction, client);
        case 'overview': return await handleOverview(interaction);
        default: return undefined;
      }
    } catch (error) {
      logger.error('Channel command error', {
        error: error.message,
        stack: error.stack,
        subcommand: sub,
        guildId: interaction.guildId,
        userId: interaction.user.id,
      });
      const message = friendlyDiscordError(error);
      if (interaction.deferred || interaction.replied) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message }).catch(() => {});
      }
      return interaction.reply({ content: `⚠️ ${message}`, flags: EPHEMERAL }).catch(() => {});
    }
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function friendlyDiscordError(error) {
  const code = error?.code;
  if (code === 50013) return 'Discord refused: I\'m missing permissions, or the role is above my highest role. Move my role higher and make sure I have **Manage Channels** and **Manage Roles**.';
  if (code === 50001) return 'I can\'t access that channel. Give me **View Channel** there first.';
  if (code === 30013 || code === 30005) return 'Discord limit reached (too many channels, or the category is full — max 50 channels per category).';
  if (code === 50035) return 'Discord rejected one of the values (name too long, invalid option…).';
  return error?.userMessage || 'Something went wrong while changing the channel. Please try again.';
}

const reasonFor = (interaction, action) => `${action} by ${interaction.user.tag} (${interaction.user.id})`;

async function audit(client, interaction, action, target, metadata = {}) {
  try {
    await logEvent({
      client,
      guild: interaction.guild,
      event: {
        action,
        target,
        executor: `${interaction.user.tag} (${interaction.user.id})`,
        metadata: { moderatorId: interaction.user.id, ...metadata },
      },
    });
  } catch (error) {
    logger.debug(`Could not write channel audit log: ${error.message}`);
  }
}

const roleIdsFrom = (interaction) => [
  interaction.options.getRole('role'),
  interaction.options.getRole('role2'),
].filter(Boolean).map((role) => role.id);

/** Executor + bot checks shared by everything that touches permission overwrites. Returns an error string or null. */
function overwritePrecheck(interaction, roleIds, preset) {
  const botProblem = botPermissionProblem(interaction.guild, { needsRoles: preset && preset !== 'public' });
  if (botProblem) return botProblem;

  const executor = interaction.member;
  if (preset && preset !== 'public' && !isAdminLike(executor) && !executor.permissions.has(P.ManageRoles)) {
    return 'You need **Manage Roles** (Manage Permissions) to use permission presets.';
  }

  for (const id of roleIds) {
    const role = interaction.guild.roles.cache.get(id);
    if (!role) return 'One of the selected roles no longer exists.';
    if (!canManageRole(executor, role)) return `You can't grant access to ${role} — it is at or above your highest role.`;
  }
  return null;
}

function presetSummary(preset, roleIds) {
  const info = PRESETS[preset] || PRESETS.public;
  const roles = roleIds.length ? roleIds.map((id) => `<@&${id}>`).join(', ') : null;
  return `${info.emoji} **${info.label}** — ${info.description}${roles ? `\nRoles: ${roles}` : ''}`;
}

function presetWarning(preset, roleIds) {
  if ((preset === 'private') && roleIds.length === 0) {
    return '⚠️ No role selected: only administrators (and me) will be able to see it. Use `/channel permissions` to add roles.';
  }
  if (preset === 'read_only' && roleIds.length === 0) {
    return 'ℹ️ No role selected: nobody can write here except administrators.';
  }
  return null;
}

/** Yes/No confirmation with buttons. Resolves true only on explicit confirmation by the invoker. */
async function confirmAction(interaction, embed, { confirmLabel = 'Confirm', danger = false } = {}) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ch_confirm').setLabel(confirmLabel).setStyle(danger ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ch_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  const message = await interaction.editReply({ embeds: [embed], components: [row] });

  const pressed = await message
    .awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === interaction.user.id,
      time: 60_000,
    })
    .catch(() => null);

  if (!pressed) {
    await interaction.editReply({ embeds: [warningEmbed('Timed out', 'Nothing was changed.')], components: [] }).catch(() => {});
    return null;
  }
  await pressed.deferUpdate().catch(() => {});
  if (pressed.customId !== 'ch_confirm') {
    await interaction.editReply({ embeds: [warningEmbed('Cancelled', 'Nothing was changed.')], components: [] }).catch(() => {});
    return null;
  }
  return pressed;
}

function checkChannelCapacity(guild, category, extra = 1) {
  if (!guildChannelRoom(guild, extra)) return 'This server has reached Discord\'s limit of 500 channels.';
  if (!categoryRoom(category, extra)) return `**${category.name}** is full (Discord allows 50 channels per category).`;
  return null;
}

function executorCanManage(interaction, channel) {
  if (isAdminLike(interaction.member)) return true;
  return Boolean(channel.permissionsFor(interaction.member)?.has(P.ManageChannels));
}

// ---------------------------------------------------------------------------
// create / category
// ---------------------------------------------------------------------------

async function handleCreate(interaction, client) {
  const { guild } = interaction;
  const rawName = interaction.options.getString('name', true);
  const typeKey = interaction.options.getString('type') || 'text';
  const typeInfo = CHANNEL_TYPES[typeKey];
  const category = interaction.options.getChannel('category');
  const preset = interaction.options.getString('preset') || 'public';
  const roleIds = roleIdsFrom(interaction);
  const topic = interaction.options.getString('topic');
  const slowmode = interaction.options.getInteger('slowmode');
  const nsfw = interaction.options.getBoolean('nsfw');
  const userLimit = interaction.options.getInteger('user_limit');

  const name = formatChannelName(rawName, typeInfo.type);
  if (!name) return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'That name has no valid characters.' });

  const capacity = checkChannelCapacity(guild, category);
  if (capacity) return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: capacity });

  const problem = overwritePrecheck(interaction, roleIds, preset);
  if (problem) return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: problem });

  const options = {
    name,
    type: typeInfo.type,
    parent: category?.id,
    reason: reasonFor(interaction, 'Channel created'),
  };
  if (preset !== 'public') {
    options.permissionOverwrites = buildPresetOverwrites(guild, preset, { channelType: typeInfo.type, roleIds });
  }
  const textLike = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum].includes(typeInfo.type);
  if (topic && (textLike || typeInfo.type === ChannelType.GuildStageVoice)) options.topic = topic;
  if (slowmode != null && [ChannelType.GuildText, ChannelType.GuildForum].includes(typeInfo.type)) options.rateLimitPerUser = slowmode;
  if (nsfw != null && typeInfo.type !== ChannelType.GuildStageVoice) options.nsfw = nsfw;
  if (userLimit != null && typeInfo.type === ChannelType.GuildVoice) options.userLimit = userLimit;

  const channel = await guild.channels.create(options);

  await audit(client, interaction, 'Channel Created', channel.toString(), { channelId: channel.id, preset });

  const lines = [
    `${channel} was created${category ? ` in **${category.name}**` : ''}.`,
    '',
    `**Type:** ${typeInfo.emoji} ${typeInfo.label}`,
    `**Access:** ${presetSummary(preset, roleIds)}`,
    category && preset === 'public' ? `**Permissions:** synced with **${category.name}**` : null,
    presetWarning(preset, roleIds),
  ].filter((line) => line !== null);

  return interaction.editReply({ embeds: [successEmbed('Channel created', lines.join('\n'))] });
}

async function handleCategory(interaction, client) {
  const { guild } = interaction;
  const name = formatChannelName(interaction.options.getString('name', true), ChannelType.GuildCategory);
  const preset = interaction.options.getString('preset') || 'public';
  const roleIds = roleIdsFrom(interaction);

  if (!name) return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'That name has no valid characters.' });
  const capacity = checkChannelCapacity(guild, null);
  if (capacity) return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: capacity });
  const problem = overwritePrecheck(interaction, roleIds, preset);
  if (problem) return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: problem });

  const category = await guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    permissionOverwrites: preset === 'public' ? undefined : buildPresetOverwrites(guild, preset, { roleIds }),
    reason: reasonFor(interaction, 'Category created'),
  });

  await audit(client, interaction, 'Category Created', category.name, { channelId: category.id, preset });

  const lines = [
    `**${category.name}** was created.`,
    '',
    `**Access:** ${presetSummary(preset, roleIds)}`,
    'Channels you create inside it inherit these permissions.',
    presetWarning(preset, roleIds),
  ].filter(Boolean);
  return interaction.editReply({ embeds: [successEmbed('Category created', lines.join('\n'))] });
}

// ---------------------------------------------------------------------------
// bulk
// ---------------------------------------------------------------------------

function renderLayoutPreview(items) {
  const lines = [];
  for (const item of items) {
    if (item.kind === 'category') {
      lines.push(`📁 **${item.name}**`);
    } else {
      const info = CHANNEL_TYPES[item.typeKey];
      lines.push(`${item.categoryIndex == null ? '' : '┗ '}${info.emoji} ${item.name}`);
    }
  }
  return clip(lines.join('\n'), 3800);
}

async function handleBulk(interaction, client) {
  const preset = interaction.options.getString('preset') || 'public';
  const roleIds = roleIdsFrom(interaction);

  const problem = overwritePrecheck(interaction, roleIds, preset);
  if (problem) return interaction.reply({ content: `⚠️ ${problem}`, flags: EPHEMERAL });

  const modal = new ModalBuilder()
    .setCustomId('ch_bulk_modal')
    .setTitle('Build server layout')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('layout')
          .setLabel('> Category  # text  ~ voice  ! news  ? forum  ^ stage')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('> Information\n# rules\n! announcements\n> Community\n# general-chat\n~ Lounge')
          .setMaxLength(4000)
          .setRequired(true),
      ),
    );

  await interaction.showModal(modal);
  const submitted = await interaction
    .awaitModalSubmit({ filter: (i) => i.customId === 'ch_bulk_modal' && i.user.id === interaction.user.id, time: 10 * 60_000 })
    .catch(() => null);
  if (!submitted) return undefined;

  await submitted.deferReply({ flags: EPHEMERAL });
  const { items, errors } = parseLayout(submitted.fields.getTextInputValue('layout'));

  if (errors.length) {
    return submitted.editReply({ embeds: [warningEmbed('Fix these lines', clip(errors.slice(0, 10).join('\n'), 3500))] });
  }
  if (items.length === 0) {
    return submitted.editReply({ embeds: [warningEmbed('Nothing to create', 'Add at least one category or channel.')] });
  }
  if (items.length > MAX_BULK_ITEMS) {
    return submitted.editReply({ embeds: [warningEmbed('Too many items', `Create at most ${MAX_BULK_ITEMS} channels/categories at once (you sent ${items.length}).`)] });
  }
  if (!guildChannelRoom(interaction.guild, items.length)) {
    return submitted.editReply({ embeds: [warningEmbed('Not enough room', 'This would exceed Discord\'s limit of 500 channels.')] });
  }
  // Max 50 channels per category.
  const perCategory = new Map();
  for (const item of items) {
    if (item.kind === 'channel' && item.categoryIndex != null) {
      perCategory.set(item.categoryIndex, (perCategory.get(item.categoryIndex) || 0) + 1);
    }
  }
  if ([...perCategory.values()].some((n) => n > 50)) {
    return submitted.editReply({ embeds: [warningEmbed('Category too big', 'Discord allows at most 50 channels per category.')] });
  }

  const categories = items.filter((i) => i.kind === 'category').length;
  const preview = new EmbedBuilder()
    .setColor(getColor('info'))
    .setTitle('Review the layout')
    .setDescription(renderLayoutPreview(items))
    .addFields(
      { name: 'Will create', value: `${categories} categor${categories === 1 ? 'y' : 'ies'}, ${items.length - categories} channel(s)`, inline: true },
      { name: 'Access', value: presetSummary(preset, roleIds) },
    );
  const warning = presetWarning(preset, roleIds);
  if (warning) preview.addFields({ name: 'Heads up', value: warning });

  // `confirmAction` edits via interaction.editReply — point it at the modal submission.
  const proxy = Object.assign(Object.create(submitted), { user: interaction.user });
  const pressed = await confirmAction(proxy, preview, { confirmLabel: `Create ${items.length} item(s)` });
  if (!pressed) return undefined;

  return buildLayout(submitted, client, items, preset, roleIds);
}

async function buildLayout(interaction, client, items, preset, roleIds) {
  const { guild } = interaction;
  const reason = reasonFor(interaction, 'Bulk layout');
  const categoryIds = new Map(); // index in items -> created category id
  const created = [];

  try {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];

      if (item.kind === 'category') {
        const category = await guild.channels.create({
          name: item.name,
          type: ChannelType.GuildCategory,
          permissionOverwrites: preset === 'public' ? undefined : buildPresetOverwrites(guild, preset, { roleIds }),
          reason,
        });
        categoryIds.set(index, category.id);
        created.push(category);
      } else {
        const parent = item.categoryIndex != null ? categoryIds.get(item.categoryIndex) : undefined;
        const options = { name: item.name, type: item.type, parent, reason };
        // Channels inside a category inherit its preset; loose channels get the preset themselves.
        if (!parent && preset !== 'public') {
          options.permissionOverwrites = buildPresetOverwrites(guild, preset, { channelType: item.type, roleIds });
        }
        created.push(await guild.channels.create(options));
      }

      if (index % 5 === 4) {
        await interaction.editReply({
          embeds: [createEmbed({ title: 'Building…', description: `Created ${index + 1} of ${items.length}`, color: 'info' })],
          components: [],
        }).catch(() => {});
      }
    }
  } catch (error) {
    logger.error('Bulk layout failed part-way', { error: error.message, created: created.length, guildId: guild.id });
    return interaction.editReply({
      embeds: [warningEmbed(
        'Stopped part-way',
        `Created ${created.length} of ${items.length} before an error:\n${friendlyDiscordError(error)}\n\nWhat was created has been kept.`,
      )],
      components: [],
    });
  }

  await audit(client, interaction, 'Bulk Layout Created', `${created.length} channels`, { preset, count: created.length });

  return interaction.editReply({
    embeds: [successEmbed(
      'Layout created',
      `Created **${created.length}** item(s).\n\n${created
        .map((channel) => (channel.type === ChannelType.GuildCategory ? `📁 **${channel.name}**` : `┗ ${channel}`))
        .join('\n')
        .slice(0, 3500)}`,
    )],
    components: [],
  });
}

// ---------------------------------------------------------------------------
// edit / clone / delete / sync
// ---------------------------------------------------------------------------

async function handleEdit(interaction, client) {
  const channel = interaction.options.getChannel('channel', true);
  const name = interaction.options.getString('name');
  const topic = interaction.options.getString('topic');
  const slowmode = interaction.options.getInteger('slowmode');
  const nsfw = interaction.options.getBoolean('nsfw');
  const category = interaction.options.getChannel('category');
  const userLimit = interaction.options.getInteger('user_limit');

  if (!executorCanManage(interaction, channel)) {
    return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need **Manage Channel** permission on that channel.' });
  }
  const botProblem = botPermissionProblem(interaction.guild);
  if (botProblem) return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: botProblem });

  const patch = {};
  const changes = [];
  const isCategory = channel.type === ChannelType.GuildCategory;
  const textLike = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum].includes(channel.type);

  if (name) {
    const formatted = formatChannelName(name, channel.type);
    if (!formatted) return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'That name has no valid characters.' });
    patch.name = formatted;
    changes.push(`**Name:** ${channel.name} → ${formatted}`);
  }
  if (topic != null && (textLike || channel.type === ChannelType.GuildStageVoice)) {
    patch.topic = topic;
    changes.push('**Topic** updated');
  }
  if (slowmode != null && [ChannelType.GuildText, ChannelType.GuildForum].includes(channel.type)) {
    patch.rateLimitPerUser = slowmode;
    changes.push(`**Slowmode:** ${slowmode ? `${slowmode}s` : 'off'}`);
  }
  if (nsfw != null && !isCategory && channel.type !== ChannelType.GuildStageVoice) {
    patch.nsfw = nsfw;
    changes.push(`**NSFW:** ${nsfw ? 'on' : 'off'}`);
  }
  if (userLimit != null && channel.type === ChannelType.GuildVoice) {
    patch.userLimit = userLimit;
    changes.push(`**User limit:** ${userLimit || 'unlimited'}`);
  }
  if (category && !isCategory) {
    const capacity = checkChannelCapacity(interaction.guild, category);
    if (capacity && channel.parentId !== category.id) return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: capacity });
    patch.parent = category.id;
    changes.push(`**Moved to:** ${category.name} (permissions are kept — use \`/channel sync\` to inherit the category's)`);
  }

  if (changes.length === 0) {
    return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'Nothing to change — pass at least one option that applies to this channel type.' });
  }

  await channel.edit({ ...patch, lockPermissions: false, reason: reasonFor(interaction, 'Channel edited') });
  await audit(client, interaction, 'Channel Edited', channel.toString(), { channelId: channel.id });
  return interaction.editReply({ embeds: [successEmbed('Channel updated', `${channel}\n\n${changes.join('\n')}`)] });
}

async function handleClone(interaction, client) {
  const channel = interaction.options.getChannel('channel', true);
  const name = interaction.options.getString('name');

  if (!executorCanManage(interaction, channel)) {
    return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need **Manage Channel** permission on that channel.' });
  }
  const botProblem = botPermissionProblem(interaction.guild, { needsRoles: true });
  if (botProblem) return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: botProblem });
  const capacity = checkChannelCapacity(interaction.guild, channel.parent);
  if (capacity) return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: capacity });

  const formatted = name ? formatChannelName(name, channel.type) : undefined;
  if (name && !formatted) return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'That name has no valid characters.' });

  const copy = await channel.clone({ name: formatted, reason: reasonFor(interaction, 'Channel cloned') });
  await audit(client, interaction, 'Channel Cloned', copy.toString(), { sourceId: channel.id, channelId: copy.id });
  return interaction.editReply({ embeds: [successEmbed('Channel cloned', `${channel} → ${copy}\nSettings and permissions were copied.`)] });
}

async function handleDelete(interaction, client) {
  const channel = interaction.options.getChannel('channel', true);
  const deleteChildren = interaction.options.getBoolean('delete_children') ?? false;
  const isCategory = channel.type === ChannelType.GuildCategory;

  if (!executorCanManage(interaction, channel)) {
    return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need **Manage Channel** permission on that channel.' });
  }
  const botProblem = botPermissionProblem(interaction.guild);
  if (botProblem) return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: botProblem });

  const children = isCategory ? [...channel.children.cache.values()] : [];
  const lines = [`You are about to delete **${channel.name}** (${describeChannelType(channel)}).`];
  if (isCategory) {
    lines.push(deleteChildren
      ? `⚠️ This also deletes **${children.length}** channel(s) inside it. Messages in them are lost for good.`
      : `Its **${children.length}** channel(s) will stay, but lose their category.`);
  } else {
    lines.push('Messages in it are lost for good. This cannot be undone.');
  }
  if (channel.id === interaction.channelId) lines.push('This is the channel you are typing in.');

  const pressed = await confirmAction(
    interaction,
    createEmbed({ title: '🗑️ Delete channel?', description: lines.join('\n'), color: 'warning' }),
    { confirmLabel: 'Delete', danger: true },
  );
  if (!pressed) return undefined;

  const reason = reasonFor(interaction, 'Channel deleted');
  const name = channel.name;
  let removed = 0;
  if (isCategory && deleteChildren) {
    for (const child of children) {
      await child.delete(reason).catch((error) => logger.warn(`Could not delete ${child.id}: ${error.message}`));
      removed += 1;
    }
  }
  await channel.delete(reason);
  await audit(client, interaction, isCategory ? 'Category Deleted' : 'Channel Deleted', name, { channelId: channel.id, childrenDeleted: removed });

  return interaction.editReply({
    embeds: [successEmbed('Deleted', `**${name}** was deleted${removed ? ` along with ${removed} channel(s)` : ''}.`)],
    components: [],
  }).catch(() => {});
}

async function handleSync(interaction, client) {
  const channel = interaction.options.getChannel('channel', true);
  if (channel.type === ChannelType.GuildCategory || !channel.parent) {
    return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'That channel is not inside a category, so there is nothing to sync with.' });
  }
  if (!isAdminLike(interaction.member) && !interaction.member.permissions.has(P.ManageRoles)) {
    return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need **Manage Roles** (Manage Permissions) to sync permissions.' });
  }
  if (!executorCanManage(interaction, channel)) {
    return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need **Manage Channel** permission on that channel.' });
  }
  const botProblem = botPermissionProblem(interaction.guild, { needsRoles: true });
  if (botProblem) return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: botProblem });

  await channel.lockPermissions();
  await audit(client, interaction, 'Channel Permissions Synced', channel.toString(), { channelId: channel.id, categoryId: channel.parentId });
  return interaction.editReply({ embeds: [successEmbed('Permissions synced', `${channel} now uses the permissions of **${channel.parent.name}**.`)] });
}

// ---------------------------------------------------------------------------
// preset
// ---------------------------------------------------------------------------

async function handlePreset(interaction, client) {
  const channel = interaction.options.getChannel('channel', true);
  const preset = interaction.options.getString('preset', true);
  const roleIds = roleIdsFrom(interaction);

  if (!executorCanManage(interaction, channel)) {
    return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need **Manage Channel** permission on that channel.' });
  }
  const problem = overwritePrecheck(interaction, roleIds, 'private');
  if (problem) return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: problem });

  const current = channel.permissionOverwrites.cache.size;
  const embed = createEmbed({
    title: `Apply preset to #${channel.name}?`,
    description: [
      presetSummary(preset, roleIds),
      '',
      `This **replaces** the ${current} existing permission overwrite(s) on ${channel}.`,
      channel.type === ChannelType.GuildCategory ? 'Channels synced with this category inherit the change.' : null,
      presetWarning(preset, roleIds),
    ].filter(Boolean).join('\n'),
    color: 'warning',
  });

  const pressed = await confirmAction(interaction, embed, { confirmLabel: 'Apply preset' });
  if (!pressed) return undefined;

  await applyPresetToChannel(interaction.guild, channel, preset, { roleIds, reason: reasonFor(interaction, `Preset ${preset} applied`) });
  await audit(client, interaction, 'Channel Preset Applied', channel.toString(), { channelId: channel.id, preset });
  return interaction.editReply({
    embeds: [successEmbed('Preset applied', `${channel} is now ${presetSummary(preset, roleIds)}`)],
    components: [],
  });
}

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------

function describeOverwrite(guild, overwrite) {
  const target = overwrite.type === 0
    ? (overwrite.id === guild.id ? '@everyone' : (guild.roles.cache.get(overwrite.id)?.toString() ?? `Deleted role (${overwrite.id})`))
    : `<@${overwrite.id}>`;
  const names = (bits) => bits.toArray().map((key) => permissionLabel(key));
  const allow = names(overwrite.allow);
  const deny = names(overwrite.deny);
  const parts = [];
  if (allow.length) parts.push(`✅ ${allow.join(', ')}`);
  if (deny.length) parts.push(`❌ ${deny.join(', ')}`);
  return { target, text: parts.join('\n') || '➖ No explicit permissions' };
}

async function handleOverview(interaction) {
  const channel = interaction.options.getChannel('channel', true);
  const overwrites = [...channel.permissionOverwrites.cache.values()];

  const embed = new EmbedBuilder()
    .setColor(getColor('info'))
    .setTitle(`Permissions · ${channel.name}`)
    .setDescription([
      `${describeChannelType(channel)}${channel.parent ? ` · in **${channel.parent.name}**` : ''}`,
      channel.parent && channel.type !== ChannelType.GuildCategory
        ? (channel.permissionsLocked ? '🔗 Synced with its category' : '✂️ Custom permissions (not synced)')
        : null,
      overwrites.length === 0 ? '\nNo permission overwrites — everyone gets the server-wide defaults.' : null,
    ].filter(Boolean).join('\n'));

  const shown = overwrites.slice(0, 24);
  for (const overwrite of shown) {
    const { target, text } = describeOverwrite(interaction.guild, overwrite);
    const title = overwrite.type === 0
      ? (overwrite.id === interaction.guild.id ? '@everyone' : (interaction.guild.roles.cache.get(overwrite.id)?.name ?? 'Deleted role'))
      : (interaction.guild.members.cache.get(overwrite.id)?.displayName ?? 'Member');
    embed.addFields({ name: clip(title, 256), value: clip(`${target}\n${text}`, 1024) });
  }
  if (overwrites.length > shown.length) {
    embed.addFields({ name: '…', value: `And ${overwrites.length - shown.length} more overwrite(s).` });
  }
  embed.setFooter({ text: 'Use /channel permissions to edit • /channel preset for quick setups' });
  return interaction.editReply({ embeds: [embed] });
}

// ---------------------------------------------------------------------------
// permissions (interactive editor)
// ---------------------------------------------------------------------------

const QUICK_PRESETS = {
  full: { label: 'Full access', emoji: '✅', description: 'View, chat, react, attach, use commands' },
  readonly: { label: 'Read-only', emoji: '📖', description: 'Can see and read, cannot write or react' },
  hide: { label: 'Hide channel', emoji: '🫥', description: 'Deny View Channel' },
  mute: { label: 'Mute', emoji: '🔇', description: 'Cannot send messages, speak or react' },
  reset: { label: 'Reset (remove overwrite)', emoji: '🧹', description: 'Back to inherited permissions' },
};

function quickPresetChanges(key, channelType) {
  const voice = isVoiceLike(channelType);
  switch (key) {
    case 'full': {
      const keys = voice
        ? ['ViewChannel', 'Connect', 'Speak', 'Stream', 'UseVAD', 'UseApplicationCommands']
        : ['ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'ReadMessageHistory', 'EmbedLinks', 'AttachFiles', 'AddReactions', 'UseApplicationCommands'];
      return Object.fromEntries(keys.map((k) => [k, true]));
    }
    case 'readonly':
      return {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: false,
        SendMessagesInThreads: false,
        CreatePublicThreads: false,
        CreatePrivateThreads: false,
        AddReactions: false,
        ...(voice ? { Speak: false } : {}),
      };
    case 'hide':
      return { ViewChannel: false };
    case 'mute':
      return voice
        ? { Speak: false }
        : { SendMessages: false, SendMessagesInThreads: false, AddReactions: false, CreatePublicThreads: false, CreatePrivateThreads: false };
    default:
      return {};
  }
}

function targetMention(target) {
  return target.kind === 'role' ? (target.id === target.guildId ? '@everyone' : `<@&${target.id}>`) : `<@${target.id}>`;
}

function renderPermissionEditor(channel, target, selected) {
  const overwrite = channel.permissionOverwrites.cache.get(target.id);
  const lineFor = (perm) => {
    const state = overwriteState(overwrite, perm.key);
    const mark = selected.has(perm.key) ? '▶ ' : '';
    return `${mark}${STATE_ICON[state]} ${perm.label}`;
  };
  const voiceFirst = isVoiceLike(channel.type);
  const textLines = TEXT_PERMISSIONS.map(lineFor).join('\n');
  const otherLines = VOICE_AND_ADMIN_PERMISSIONS.map(lineFor).join('\n');

  const embed = new EmbedBuilder()
    .setColor(getColor('info'))
    .setTitle(`Permissions · ${channel.name}`)
    .setDescription([
      `Editing ${targetMention(target)} on ${channel}`,
      `✅ allowed  ❌ denied  ➖ inherited  ▶ selected`,
      '',
      '**1.** Pick permissions in the menus   **2.** Press Allow / Deny / Reset',
      'Changes apply instantly.',
    ].join('\n'))
    .addFields(
      { name: voiceFirst ? 'Text permissions' : 'Text & messages', value: clip(textLines, 1024), inline: true },
      { name: 'Voice & management', value: clip(otherLines, 1024), inline: true },
    );
  return embed;
}

function permissionSelect(id, placeholder, perms, overwrite, selected) {
  return new StringSelectMenuBuilder()
    .setCustomId(id)
    .setPlaceholder(placeholder)
    .setMinValues(0)
    .setMaxValues(perms.length)
    .addOptions(perms.map((perm) => new StringSelectMenuOptionBuilder()
      .setLabel(perm.label)
      .setValue(perm.key)
      .setDescription(`Currently: ${{ allow: 'Allowed', deny: 'Denied', inherit: 'Inherited' }[overwriteState(overwrite, perm.key)]}`)
      .setDefault(selected.has(perm.key))));
}

function permissionComponents(channel, target, selected, { disabled = false } = {}) {
  const overwrite = channel.permissionOverwrites.cache.get(target.id);
  const hasSelection = selected.size > 0;

  const presetMenu = new StringSelectMenuBuilder()
    .setCustomId('pe_preset')
    .setPlaceholder('Quick preset for this role / member…')
    .addOptions(Object.entries(QUICK_PRESETS).map(([value, p]) => new StringSelectMenuOptionBuilder()
      .setLabel(p.label)
      .setValue(value)
      .setEmoji(p.emoji)
      .setDescription(p.description)));

  const canSync = channel.type !== ChannelType.GuildCategory && Boolean(channel.parent);

  const rows = [
    new ActionRowBuilder().addComponents(permissionSelect('pe_text', 'Text & message permissions…', TEXT_PERMISSIONS, overwrite, selected)),
    new ActionRowBuilder().addComponents(permissionSelect('pe_voice', 'Voice & management permissions…', VOICE_AND_ADMIN_PERMISSIONS, overwrite, selected)),
    new ActionRowBuilder().addComponents(presetMenu),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pe_allow').setLabel('Allow').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(!hasSelection),
      new ButtonBuilder().setCustomId('pe_deny').setLabel('Deny').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(!hasSelection),
      new ButtonBuilder().setCustomId('pe_inherit').setLabel('Reset').setEmoji('➖').setStyle(ButtonStyle.Secondary).setDisabled(!hasSelection),
      new ButtonBuilder().setCustomId('pe_clear').setLabel('Clear selection').setStyle(ButtonStyle.Secondary).setDisabled(!hasSelection),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pe_sync').setLabel('Sync with category').setEmoji('🔗').setStyle(ButtonStyle.Secondary).setDisabled(!canSync),
      new ButtonBuilder().setCustomId('pe_remove').setLabel('Remove all overwrites').setEmoji('🧹').setStyle(ButtonStyle.Secondary).setDisabled(!overwrite),
      new ButtonBuilder().setCustomId('pe_done').setLabel('Done').setStyle(ButtonStyle.Primary),
    ),
  ];

  if (disabled) rows.forEach((row) => row.components.forEach((c) => c.setDisabled(true)));
  return rows;
}

async function handlePermissions(interaction, client) {
  const { guild } = interaction;
  let channel = interaction.options.getChannel('channel', true);
  const role = interaction.options.getRole('role');
  const user = interaction.options.getUser('user');

  if (role && user) {
    return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'Choose either a role **or** a user, not both.' });
  }

  const executor = interaction.member;
  if (!isAdminLike(executor) && !channel.permissionsFor(executor)?.has(P.ManageRoles)) {
    return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need **Manage Permissions** on that channel.' });
  }
  const botProblem = botPermissionProblem(guild, { needsRoles: true });
  if (botProblem) return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: botProblem });

  let target;
  let targetObject;
  if (user) {
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'That user is not in this server.' });
    if (!canManageMember(executor, member)) {
      return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You can\'t edit permissions of someone at or above your highest role.' });
    }
    target = { kind: 'member', id: member.id, guildId: guild.id };
    targetObject = member;
  } else {
    const chosen = role ?? guild.roles.everyone;
    if (!canManageRole(executor, chosen)) {
      return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: `You can't edit permissions of ${chosen} — it is at or above your highest role.` });
    }
    target = { kind: 'role', id: chosen.id, guildId: guild.id };
    targetObject = chosen;
  }

  const selected = new Set();
  const render = (disabled = false) => ({
    embeds: [renderPermissionEditor(channel, target, selected)],
    components: permissionComponents(channel, target, selected, { disabled }),
  });

  const message = await interaction.editReply(render());
  const collector = message.createMessageComponentCollector({
    filter: (i) => i.user.id === interaction.user.id,
    time: 10 * 60_000,
  });

  const refresh = async () => {
    channel = await channel.fetch().catch(() => channel);
  };

  const applyChanges = async (i, changes, label) => {
    const keys = Object.keys(changes);
    const wantsAllow = keys.filter((k) => changes[k] === true);
    const { allowed, blocked } = filterGrantablePermissions(executor, channel, wantsAllow);
    const final = { ...changes };
    blocked.forEach((k) => delete final[k]);

    if (Object.keys(final).length) {
      await channel.permissionOverwrites.edit(targetObject, final, { reason: reasonFor(interaction, `Permissions ${label}`) });
      await refresh();
      await audit(client, interaction, 'Channel Permissions Changed', channel.toString(), {
        channelId: channel.id,
        target: target.id,
        targetKind: target.kind,
        changes: Object.fromEntries(Object.entries(final).map(([k, v]) => [k, v === true ? 'allow' : v === false ? 'deny' : 'reset'])),
      });
    }
    await i.update(render());
    if (blocked.length) {
      await i.followUp({
        content: `⚠️ You can't grant permissions you don't have yourself: ${blocked.map(permissionLabel).join(', ')}.${allowed.length ? ' The rest was applied.' : ''}`,
        flags: EPHEMERAL,
      }).catch(() => {});
    }
  };

  collector.on('collect', async (i) => {
    try {
      switch (i.customId) {
        case 'pe_text':
        case 'pe_voice': {
          const group = i.customId === 'pe_text' ? TEXT_PERMISSIONS : VOICE_AND_ADMIN_PERMISSIONS;
          group.forEach((p) => selected.delete(p.key));
          i.values.forEach((value) => selected.add(value));
          await i.update(render());
          break;
        }
        case 'pe_clear':
          selected.clear();
          await i.update(render());
          break;
        case 'pe_allow':
        case 'pe_deny':
        case 'pe_inherit': {
          const value = i.customId === 'pe_allow' ? true : i.customId === 'pe_deny' ? false : null;
          const changes = Object.fromEntries([...selected].map((key) => [key, value]));
          selected.clear();
          await applyChanges(i, changes, value === true ? 'allowed' : value === false ? 'denied' : 'reset');
          break;
        }
        case 'pe_preset': {
          const key = i.values[0];
          selected.clear();
          if (key === 'reset') {
            await channel.permissionOverwrites.delete(targetObject, reasonFor(interaction, 'Permissions reset'));
            await refresh();
            await audit(client, interaction, 'Channel Permissions Reset', channel.toString(), { channelId: channel.id, target: target.id });
            await i.update(render());
          } else {
            await applyChanges(i, quickPresetChanges(key, channel.type), `preset ${key}`);
          }
          break;
        }
        case 'pe_remove':
          selected.clear();
          await channel.permissionOverwrites.delete(targetObject, reasonFor(interaction, 'Permissions removed'));
          await refresh();
          await audit(client, interaction, 'Channel Permissions Reset', channel.toString(), { channelId: channel.id, target: target.id });
          await i.update(render());
          break;
        case 'pe_sync':
          await channel.lockPermissions();
          await refresh();
          selected.clear();
          await audit(client, interaction, 'Channel Permissions Synced', channel.toString(), { channelId: channel.id });
          await i.update(render());
          await i.followUp({ content: `🔗 Synced with **${channel.parent?.name}**.`, flags: EPHEMERAL }).catch(() => {});
          break;
        case 'pe_done':
          await i.update(render(true));
          collector.stop('done');
          break;
        default:
          await i.deferUpdate().catch(() => {});
      }
    } catch (error) {
      logger.error('Permission editor error', { error: error.message, customId: i.customId, guildId: guild.id });
      const content = `⚠️ ${friendlyDiscordError(error)}`;
      if (i.deferred || i.replied) await i.followUp({ content, flags: EPHEMERAL }).catch(() => {});
      else await i.reply({ content, flags: EPHEMERAL }).catch(() => {});
    }
  });

  collector.on('end', async (_collected, reason) => {
    if (reason === 'done') return;
    await interaction.editReply(render(true)).catch(() => {});
  });

  return undefined;
}

export { describeOverwrite, quickPresetChanges };
