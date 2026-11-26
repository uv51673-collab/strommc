// ticket_setup_builder.js — interactive ticket panel builder used by `/ticket setup`.
//
// Layout (all ephemeral):
//   1. the original reply  -> LIVE PREVIEW of the panel (real embed + real buttons/dropdown, disabled)
//   2. a follow-up message -> the builder controls
// Every change re-renders both, so what you see is exactly what gets posted.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ComponentType,
  EmbedBuilder,
  FileUploadBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { getColor } from '../../../config/bot.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import { publishTicketPanel } from '../../../services/ticketPanelService.js';
import { logger } from '../../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../../utils/errorHandler.js';
import {
  BUTTON_STYLES,
  MAX_TICKET_TYPES,
  buildPanelComponents,
  buildPanelEmbed,
  clip,
  defaultCategoryName,
  emojiToString,
  getPanelConfig,
  newTypeId,
  parseColor,
  parseEmoji,
} from '../../../utils/ticket/ticketPanel.js';

const SESSION_MS = 14 * 60_000; // interaction tokens live for 15 minutes
const MODAL_MS = 5 * 60_000;
const EPHEMERAL = MessageFlags.Ephemeral;

const STARTER_TYPE = () => ({
  id: newTypeId(),
  label: 'Support',
  emoji: '🎫',
  style: 'blue',
  description: 'Get help from our team',
  categoryId: null,
  categoryName: null,
});

function typeLine(type, index) {
  const emoji = emojiToString(type.emoji);
  const category = type.categoryId ? `<#${type.categoryId}>` : `📁 auto: \`${defaultCategoryName(type)}\``;
  const style = BUTTON_STYLES[type.style]?.emoji || '🔵';
  return `\`${String(index + 1).padStart(2, '0')}\` ${emoji ? `${emoji} ` : ''}**${clip(type.label, 40)}** ${style} → ${category}`;
}

function buildPreview(state) {
  const hasTypes = state.panel.types.length > 0;
  return {
    content: hasTypes
      ? '**Live preview** — this is exactly how the panel will look (buttons are disabled here).'
      : '**Live preview** — no buttons yet. Use **Add Button** below to create your first ticket type.',
    embeds: [buildPanelEmbed(state.panel)],
    components: buildPanelComponents(state.panel, { disabled: true }),
  };
}

function buildControls(state, { disabled = false, finished = null } = {}) {
  const { panel } = state;
  const count = panel.types.length;

  if (finished) {
    return { embeds: [finished], components: [] };
  }

  const list = count
    ? panel.types.map(typeLine).join('\n')
    : '_No buttons yet._';

  const embed = new EmbedBuilder()
    .setTitle('🎫 Ticket Panel Builder')
    .setColor(getColor('info'))
    .setDescription(
      'Customise the panel above, add as many ticket buttons as you need (up to 25 per panel), '
      + 'then press **Publish**. Every button gets its **own category** that is created automatically — '
      + 'tickets opened with a button are created inside that button\'s category.',
    )
    .addFields(
      { name: 'Panel channel', value: state.channelId ? `<#${state.channelId}>` : '`Not selected`', inline: true },
      { name: 'Staff role', value: state.staffRoleId ? `<@&${state.staffRoleId}>` : '`None`', inline: true },
      { name: 'Style', value: panel.mode === 'dropdown' ? 'Dropdown menu' : 'Buttons', inline: true },
      { name: `Ticket types (${count}/${MAX_TICKET_TYPES})`, value: clip(list, 1024) },
    )
    .setFooter({ text: 'Builder closes after 14 minutes of inactivity' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tb_text').setLabel('Title & Description').setEmoji('✏️').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('tb_image').setLabel('Image').setEmoji('🖼️').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('tb_color').setLabel('Color').setEmoji('🎨').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('tb_mode')
      .setLabel(panel.mode === 'dropdown' ? 'Style: Dropdown' : 'Style: Buttons')
      .setEmoji('🔀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tb_add').setLabel('Add Button').setEmoji('➕').setStyle(ButtonStyle.Primary).setDisabled(disabled || count >= MAX_TICKET_TYPES),
    new ButtonBuilder().setCustomId('tb_edit').setLabel('Edit Button').setEmoji('🛠️').setStyle(ButtonStyle.Secondary).setDisabled(disabled || count === 0),
    new ButtonBuilder().setCustomId('tb_remove').setLabel('Remove Button').setEmoji('➖').setStyle(ButtonStyle.Secondary).setDisabled(disabled || count === 0),
  );

  const channelMenu = new ChannelSelectMenuBuilder()
    .setCustomId('tb_channel')
    .setPlaceholder('Where should the panel be posted?')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(disabled);
  if (state.channelId) channelMenu.setDefaultChannels([state.channelId]);

  const roleMenu = new RoleSelectMenuBuilder()
    .setCustomId('tb_role')
    .setPlaceholder('Staff role that can see all tickets (optional)')
    .setMinValues(0)
    .setMaxValues(1)
    .setDisabled(disabled);
  if (state.staffRoleId) roleMenu.setDefaultRoles([state.staffRoleId]);

  const row5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('tb_publish')
      .setLabel(state.isUpdate ? 'Update Panel' : 'Publish Panel')
      .setEmoji('🚀')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled || count === 0 || !state.channelId),
    new ButtonBuilder().setCustomId('tb_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );

  return {
    embeds: [embed],
    components: [row1, row2, new ActionRowBuilder().addComponents(channelMenu), new ActionRowBuilder().addComponents(roleMenu), row5],
  };
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

async function askModal(source, modal, customId) {
  try {
    await source.showModal(modal);
  } catch (error) {
    logger.debug(`Ticket builder could not open modal ${customId}: ${error.message}`);
    return null;
  }
  const submitted = await source
    .awaitModalSubmit({
      filter: (i) => i.customId === customId && i.user.id === source.user.id,
      time: MODAL_MS,
    })
    .catch(() => null);
  if (submitted) await submitted.deferUpdate().catch(() => {});
  return submitted;
}

const notify = (i, content) => i.followUp({ content: `⚠️ ${content}`, flags: EPHEMERAL }).catch(() => {});

async function editTextAndDescription(source, state) {
  const modal = new ModalBuilder()
    .setCustomId('tb_modal_text')
    .setTitle('Panel title & description')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('title')
          .setLabel('Title')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(256)
          .setRequired(true)
          .setValue(state.panel.title || ''),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('description')
          .setLabel('Description')
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(4000)
          .setRequired(true)
          .setValue(state.panel.description || ''),
      ),
    );

  const submitted = await askModal(source, modal, 'tb_modal_text');
  if (!submitted) return false;
  state.panel.title = submitted.fields.getTextInputValue('title').trim();
  state.panel.description = submitted.fields.getTextInputValue('description').trim();
  return true;
}

async function editImage(source, state) {
  const modal = new ModalBuilder()
    .setCustomId('tb_modal_image')
    .setTitle('Panel image')
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        'Paste a direct image link **or** upload a file. An uploaded file wins if both are given. '
        + 'Leave both empty to remove the image.',
      ),
    )
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Image URL (optional)')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('image_input')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('https://example.com/banner.png')
            .setValue(state.panel.imageUrl || '')
            .setRequired(false),
        ),
      new LabelBuilder()
        .setLabel('Or upload an image (optional)')
        .setFileUploadComponent(new FileUploadBuilder().setCustomId('image_upload').setRequired(false)),
    );

  const submitted = await askModal(source, modal, 'tb_modal_image');
  if (!submitted) return false;

  const uploaded = submitted.fields.getUploadedFiles('image_upload');
  const imageUrl = uploaded?.at(0)?.url ?? submitted.fields.getTextInputValue('image_input').trim();

  if (imageUrl) {
    try {
      const url = new URL(imageUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
    } catch {
      await notify(submitted, 'That is not a valid image link. It must start with `http://` or `https://`.');
      return false;
    }
  }
  state.panel.imageUrl = imageUrl || null;
  return true;
}

async function editColor(source, state) {
  const modal = new ModalBuilder()
    .setCustomId('tb_modal_color')
    .setTitle('Panel color')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('color')
          .setLabel('Hex color (empty = default)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('#5865F2')
          .setMaxLength(7)
          .setRequired(false)
          .setValue(state.panel.color || ''),
      ),
    );

  const submitted = await askModal(source, modal, 'tb_modal_color');
  if (!submitted) return false;

  const raw = submitted.fields.getTextInputValue('color').trim();
  if (!raw) {
    state.panel.color = null;
    return true;
  }
  const color = parseColor(raw);
  if (!color) {
    await notify(submitted, 'Use a 6-digit hex color like `#5865F2`.');
    return false;
  }
  state.panel.color = color;
  return true;
}

/** Add (type = null) or edit a ticket button. Returns the saved type or null. */
async function editType(source, state, type = null) {
  const isEdit = Boolean(type);
  const modalId = `tb_modal_type_${isEdit ? 'edit' : 'add'}`;
  const currentStyle = type?.style && BUTTON_STYLES[type.style] ? type.style : 'blue';

  const styleMenu = new StringSelectMenuBuilder()
    .setCustomId('style')
    .setRequired(false)
    .addOptions(Object.entries(BUTTON_STYLES).map(([value, info]) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(info.label)
        .setValue(value)
        .setEmoji(info.emoji)
        .setDefault(value === currentStyle),
    ));

  const modal = new ModalBuilder()
    .setCustomId(modalId)
    .setTitle(isEdit ? 'Edit ticket button' : 'Add ticket button')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Button label')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('label')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Support, Report a player, Buy / Billing…')
            .setMaxLength(80)
            .setRequired(true)
            .setValue(type?.label || ''),
        ),
      new LabelBuilder()
        .setLabel('Emoji (optional)')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('emoji')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('🎫 or a custom emoji like <:name:123456789012345678>')
            .setMaxLength(64)
            .setRequired(false)
            .setValue(emojiToString(type?.emoji) || ''),
        ),
      new LabelBuilder()
        .setLabel('Short description (optional)')
        .setDescription('Shown in the dropdown and inside the ticket.')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('description')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(100)
            .setRequired(false)
            .setValue(type?.description || ''),
        ),
      new LabelBuilder()
        .setLabel('Button color')
        .setStringSelectMenuComponent(styleMenu),
      new LabelBuilder()
        .setLabel('Category name (optional)')
        .setDescription('Auto-created for this button. Leave empty to use the button name.')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('category_name')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(100)
            .setRequired(false)
            .setValue(type?.categoryName || ''),
        ),
    );

  const submitted = await askModal(source, modal, modalId);
  if (!submitted) return null;

  const label = submitted.fields.getTextInputValue('label').trim();
  if (!label) {
    await notify(submitted, 'The button needs a label.');
    return null;
  }

  const emojiRaw = submitted.fields.getTextInputValue('emoji').trim();
  let emoji = null;
  if (emojiRaw) {
    emoji = parseEmoji(emojiRaw);
    if (!emoji) {
      await notify(submitted, 'That emoji is not valid. Use a normal emoji like 🎫 or a custom one like `<:name:id>`.');
      return null;
    }
  }

  const style = submitted.fields.getStringSelectValues('style')?.[0] || currentStyle;
  const description = submitted.fields.getTextInputValue('description').trim();
  const categoryName = submitted.fields.getTextInputValue('category_name').trim();

  const saved = type || { id: newTypeId(), categoryId: null };
  const renamedCategory = isEdit && (categoryName || null) !== (type.categoryName || null);
  Object.assign(saved, {
    label,
    emoji: emoji ? emojiToString(emoji) : null,
    style: BUTTON_STYLES[style] ? style : 'blue',
    description,
    categoryName: categoryName || null,
  });
  // A new custom category name means a new category (the old one keeps its tickets).
  if (renamedCategory && categoryName) saved.categoryId = null;
  return saved;
}

async function pickType(source, state, { placeholder, content }) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('tb_pick')
    .setPlaceholder(placeholder)
    .addOptions(state.panel.types.slice(0, 25).map((type, index) => {
      const option = new StringSelectMenuOptionBuilder()
        .setLabel(clip(`${index + 1}. ${type.label}`, 100))
        .setValue(type.id);
      const emoji = parseEmoji(emojiToString(type.emoji));
      if (emoji) option.setEmoji(emoji);
      return option;
    }));

  // `source` has already been acknowledged, so the picker is sent as an ephemeral follow-up.
  const message = await source.followUp({
    content,
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: EPHEMERAL,
  }).catch(() => null);
  if (!message) return null;

  const dismiss = () => source.webhook.deleteMessage(message.id).catch(() => {});

  const picked = await message
    .awaitMessageComponent({
      componentType: ComponentType.StringSelect,
      filter: (i) => i.user.id === source.user.id,
      time: 60_000,
    })
    .catch(() => null);

  if (!picked) {
    await dismiss();
    return null;
  }
  return { picked, type: state.panel.types.find((t) => t.id === picked.values[0]) || null, dismiss };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export async function runTicketSetupBuilder(interaction, client) {
  const guildConfig = await getGuildConfig(client, interaction.guildId);
  const panel = getPanelConfig(guildConfig);
  if (panel.types.length === 0) panel.types.push(STARTER_TYPE());

  const defaultChannelId = guildConfig.ticketPanelChannelId
    || (interaction.channel?.isTextBased?.() && !interaction.channel.isThread?.() ? interaction.channelId : null);

  const state = {
    panel,
    channelId: defaultChannelId,
    staffRoleId: guildConfig.ticketStaffRoleId || null,
    isUpdate: Boolean(guildConfig.ticketPanelChannelId),
  };

  await interaction.editReply(buildPreview(state));
  const controlsMessage = await interaction.followUp({ ...buildControls(state), flags: EPHEMERAL });

  const render = async (extra = {}) => {
    await Promise.all([
      interaction.editReply(buildPreview(state)).catch(() => {}),
      interaction.webhook.editMessage(controlsMessage.id, buildControls(state, extra)).catch(() => {}),
    ]);
  };

  const collector = controlsMessage.createMessageComponentCollector({
    filter: (i) => i.user.id === interaction.user.id,
    time: SESSION_MS,
  });

  let busy = false;

  collector.on('collect', async (i) => {
    if (busy) {
      await i.deferUpdate().catch(() => {});
      return;
    }
    busy = true;
    try {
      switch (i.customId) {
        case 'tb_text':
          if (await editTextAndDescription(i, state)) await render();
          break;
        case 'tb_image':
          if (await editImage(i, state)) await render();
          break;
        case 'tb_color':
          if (await editColor(i, state)) await render();
          break;
        case 'tb_mode':
          await i.deferUpdate();
          state.panel.mode = state.panel.mode === 'dropdown' ? 'buttons' : 'dropdown';
          await render();
          break;
        case 'tb_add': {
          if (state.panel.types.length >= MAX_TICKET_TYPES) {
            await i.deferUpdate();
            await notify(i, `A panel can hold at most ${MAX_TICKET_TYPES} buttons (Discord's limit per message).`);
            break;
          }
          const created = await editType(i, state, null);
          if (created) {
            state.panel.types.push(created);
            await render();
          }
          break;
        }
        case 'tb_edit': {
          await i.deferUpdate().catch(() => {});
          const choice = await pickType(i, state, { placeholder: 'Which button do you want to edit?', content: 'Choose a button to edit:' });
          if (!choice?.type) {
            await choice?.dismiss();
            break;
          }
          const updated = await editType(choice.picked, state, choice.type);
          await choice.dismiss();
          if (updated) await render();
          break;
        }
        case 'tb_remove': {
          await i.deferUpdate().catch(() => {});
          const choice = await pickType(i, state, { placeholder: 'Which button do you want to remove?', content: 'Choose a button to remove:' });
          if (!choice?.type) {
            await choice?.dismiss();
            break;
          }
          await choice.picked.deferUpdate().catch(() => {});
          state.panel.types = state.panel.types.filter((t) => t.id !== choice.type.id);
          await choice.dismiss();
          await render();
          break;
        }
        case 'tb_channel':
          await i.deferUpdate();
          state.channelId = i.values[0] || null;
          await render();
          break;
        case 'tb_role':
          await i.deferUpdate();
          state.staffRoleId = i.values[0] || null;
          await render();
          break;
        case 'tb_cancel':
          await i.deferUpdate();
          collector.stop('cancelled');
          break;
        case 'tb_publish': {
          await i.deferUpdate();
          await render({ disabled: true });
          try {
            const channel = await interaction.guild.channels.fetch(state.channelId).catch(() => null);
            if (!channel) throw new TitanBotError('Panel channel missing', ErrorTypes.VALIDATION, 'The selected panel channel no longer exists.');

            const { message, createdCategories } = await publishTicketPanel({
              client,
              guild: interaction.guild,
              channel,
              panel: state.panel,
              staffRoleId: state.staffRoleId,
            });

            const done = new EmbedBuilder()
              .setColor(getColor('success'))
              .setTitle(state.isUpdate ? '✅ Ticket panel updated' : '✅ Ticket panel published')
              .setDescription(`The panel is live in ${channel} — [jump to panel](${message.url}).`)
              .addFields(
                {
                  name: 'Categories',
                  value: createdCategories.length
                    ? createdCategories.map(({ type, category }) => `${category} ← **${clip(type.label, 40)}**`).join('\n')
                    : 'All buttons already had a category.',
                },
                { name: 'What happens now', value: 'Members press a button → a private ticket channel is created inside that button\'s category. Run `/ticket setup` again any time to add or change buttons.' },
              );
            collector.stop('published');
            await Promise.all([
              interaction.webhook.editMessage(controlsMessage.id, buildControls(state, { finished: done })).catch(() => {}),
              interaction.editReply(buildPreview(state)).catch(() => {}),
            ]);
          } catch (error) {
            logger.error('Ticket panel publish failed', { error: error.message, guildId: interaction.guildId });
            await render();
            await notify(i, error?.userMessage || error?.message || 'Could not publish the panel. Check my permissions and try again.');
          }
          break;
        }
        default:
          await i.deferUpdate().catch(() => {});
      }
    } catch (error) {
      logger.error('Ticket builder error', { error: error.message, customId: i.customId });
      await notify(i, 'Something went wrong. Please try that again.');
    } finally {
      busy = false;
    }
  });

  collector.on('end', async (_collected, reason) => {
    if (reason === 'published') return;
    const note = reason === 'cancelled'
      ? 'Setup cancelled — nothing was changed.'
      : 'The builder timed out — nothing was changed. Run `/ticket setup` again.';
    const closed = new EmbedBuilder().setColor(getColor('warning')).setTitle('Ticket panel builder closed').setDescription(note);
    await interaction.webhook.editMessage(controlsMessage.id, buildControls(state, { finished: closed })).catch(() => {});
    await interaction.deleteReply().catch(() => {});
  });
}
