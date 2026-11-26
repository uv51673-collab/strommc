import { openTicketModal } from '../../../handlers/ticketButtons.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import { getPanelConfig, buildPanelComponents } from '../../../utils/ticket/ticketPanel.js';
import { logger } from '../../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';

// Dropdown-style ticket panel: the chosen option is the ticket type.
export default {
  name: 'ticket_panel_select',
  async execute(interaction, client) {
    try {
      const opened = await openTicketModal(interaction, client, interaction.values?.[0] || null);

      // A select menu keeps showing the last choice, which would make picking the same type twice
      // impossible. Re-render the panel's components to reset it.
      if (opened) {
        const config = await getGuildConfig(client, interaction.guildId);
        await interaction.message
          .edit({ components: buildPanelComponents(getPanelConfig(config)) })
          .catch(() => {});
      }
    } catch (error) {
      logger.error('Error handling ticket panel select:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not open ticket creation form.' });
      }
    }
  },
};
