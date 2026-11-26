import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { getGuildConfig, setGuildConfig } from '../../services/config/guildConfig.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError, replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

import ticketConfig from './modules/ticket_dashboard.js';
import { runTicketSetupBuilder } from './modules/ticket_setup_builder.js';
import { publishTicketPanel } from '../../services/ticketPanelService.js';
import { DEFAULT_PANEL_TITLE, DEFAULT_PANEL_DESCRIPTION, newTypeId } from '../../utils/ticket/ticketPanel.js';

export default {
    data: new SlashCommandBuilder()
        .setName("ticket")
        .setDescription("Manages the server's ticket system.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .addSubcommand((subcommand) =>
            subcommand
                .setName("setup")
                .setDescription(
                    "Open the ticket panel builder (live preview, unlimited-style buttons, auto categories).",
                )
                .addChannelOption((option) =>
                    option
.setName("panel_channel")
                        .setDescription(
                            "Quick setup: post a single-button panel here. Leave empty to open the builder.",
                        )
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(false),
                )

                .addStringOption((option) =>
                    option
                        .setName("panel_message")
                        .setDescription(
                            "The main message/description for the ticket panel.",
                        )
                        .setRequired(false),
                )
                .addStringOption((option) =>
                    option
                        .setName("button_label")
                        .setDescription(
                            "The label for the ticket creation button (default: Create Ticket)",
                        )
                        .setRequired(false),
                )
                .addChannelOption((option) =>
                    option
                        .setName("category")
                        .setDescription(
                            "The category where new tickets will be created (optional).",
                        )
                        .addChannelTypes(ChannelType.GuildCategory)
                        .setRequired(false),
                )
                .addChannelOption((option) =>
                    option
                        .setName("closed_category")
                        .setDescription(
                            "The category where closed tickets will be moved (optional).",
                        )
                        .addChannelTypes(ChannelType.GuildCategory)
                        .setRequired(false),
                )
                .addRoleOption((option) =>
                    option
                        .setName("staff_role")
                        .setDescription(
                            "The role that can access tickets (optional).",
                        )
                        .setRequired(false),
                )
                .addIntegerOption((option) =>
                    option
                        .setName("max_tickets_per_user")
                        .setDescription("Maximum number of tickets a user can create (default: 3)")
                        .setMinValue(1)
                        .setMaxValue(10)
                        .setRequired(false),
                )
                .addBooleanOption((option) =>
                    option
                        .setName("dm_on_close")
                        .setDescription("Send DM to user when their ticket is closed (default: true)")
                        .setRequired(false),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("dashboard")
                .setDescription("Open the interactive ticket system dashboard"),
        ),
    category: "ticket",

    async execute(interaction, config, client) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) {
            return;
        }

        if (
            !interaction.member.permissions.has(
                PermissionFlagsBits.ManageChannels,
            )
        ) {
            logger.warn('Ticket command permission denied', {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'ticket'
            });
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need the `Manage Channels` permission for this action.' });
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === "dashboard") {
            return ticketConfig.execute(interaction, config, client);
        }

        if (subcommand === "setup") {
            const panelChannel = interaction.options.getChannel("panel_channel");

            // No options -> the interactive builder (live preview, any number of buttons, auto categories).
            if (!panelChannel) {
                try {
                    return await runTicketSetupBuilder(interaction, client);
                } catch (error) {
                    logger.error('Ticket builder failed to start', {
                        error: error.message,
                        stack: error.stack,
                        userId: interaction.user.id,
                        guildId: interaction.guildId,
                    });
                    return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not open the ticket panel builder. Please try again.' });
                }
            }

            // Quick, non-interactive setup (also used by the AI command bridge): one button.
            const categoryChannel = interaction.options.getChannel("category");
            const closedCategoryChannel = interaction.options.getChannel("closed_category");
            const staffRole = interaction.options.getRole("staff_role");
            const panelMessage = interaction.options.getString("panel_message") || DEFAULT_PANEL_DESCRIPTION;
            const buttonLabel = interaction.options.getString("button_label") || "Create Ticket";
            const maxTicketsPerUser = interaction.options.getInteger("max_tickets_per_user");
            const dmOnClose = interaction.options.getBoolean("dm_on_close");

            try {
                const { message, createdCategories, closedCategory } = await publishTicketPanel({
                    client,
                    guild: interaction.guild,
                    channel: panelChannel,
                    staffRoleId: staffRole?.id ?? null,
                    panel: {
                        title: DEFAULT_PANEL_TITLE,
                        description: panelMessage,
                        imageUrl: null,
                        color: null,
                        mode: 'buttons',
                        types: [{
                            id: newTypeId(),
                            label: buttonLabel,
                            emoji: '📩',
                            style: 'blue',
                            description: '',
                            categoryId: categoryChannel?.id ?? null,
                            categoryName: null,
                        }],
                    },
                });

                // Optional extras of the quick setup.
                const saved = await getGuildConfig(client, interaction.guildId);
                if (closedCategoryChannel) saved.ticketClosedCategoryId = closedCategoryChannel.id;
                if (maxTicketsPerUser != null) saved.maxTicketsPerUser = maxTicketsPerUser;
                if (dmOnClose != null) saved.dmOnClose = dmOnClose;
                await setGuildConfig(client, interaction.guildId, saved);

                const openCategory = categoryChannel || createdCategories[0]?.category;
                const closed = closedCategoryChannel || closedCategory;
                const lines = [
                    `The ticket panel has been sent to ${panelChannel} ([jump](${message.url})).`,
                    `New tickets are created in ${openCategory ?? 'their own category'}.`,
                    closed ? `Closed tickets are moved to ${closed}.` : null,
                    staffRole ? `**${staffRole.name}** can access tickets.` : null,
                    '',
                    `**Max Tickets Per User:** ${saved.maxTicketsPerUser ?? 3}`,
                    `**DM on Close:** ${saved.dmOnClose !== false ? 'Enabled' : 'Disabled'}`,
                    '',
                    'Tip: run `/ticket setup` without options to open the full builder (more buttons, image, title, colors).',
                ].filter((line) => line !== null);

                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [successEmbed("Ticket Panel Set Up", lines.join('\n'))],
                });

                logger.info('Ticket panel quick setup completed', {
                    userId: interaction.user.id,
                    guildId: interaction.guildId,
                    panelChannelId: panelChannel.id,
                    commandName: 'ticket_setup',
                });
            } catch (error) {
                logger.error('Ticket setup error', {
                    error: error.message,
                    stack: error.stack,
                    userId: interaction.user.id,
                    guildId: interaction.guildId,
                    commandName: 'ticket_setup'
                });
                await replyUserError(interaction, {
                    type: ErrorTypes.UNKNOWN,
                    message: error?.userMessage || 'Could not send the ticket panel or save configuration. Check the bot\'s permissions (Manage Channels, and Send Messages / Embed Links in the target channel) and database connection.',
                }).catch((err) => {
                    logger.error('Failed to send error reply', { error: err.message, guildId: interaction.guildId });
                });
            }
        }
    }
};
