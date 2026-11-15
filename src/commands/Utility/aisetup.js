import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
} from 'discord.js';
import { logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/rateLimiter.js';
import { isGeminiConfigured } from '../../services/geminiService.js';
import { requestPlan, applyPlan, botCanManageChannels } from '../../services/aiServerSetupService.js';

// Plain EmbedBuilder data is used on purpose: the shared createEmbed() helper strips emojis,
// and the whole point of this command is showing the emojis the AI picked.
const COLORS = { info: 0x5865f2, ok: 0x57f287, warn: 0xfee75c, error: 0xed4245 };
const PREVIEW_TIMEOUT_MS = 120000;
const PROGRESS_EDIT_INTERVAL_MS = 1200;

const activeGuilds = new Set();

const embed = (color, title, description, footer) =>
  new EmbedBuilder({
    color: COLORS[color],
    title,
    description: String(description).slice(0, 4000),
    ...(footer ? { footer: { text: footer } } : {}),
  });

function renderPlan(plan, statusByName = new Map()) {
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
    lines.push(`${icon(category.name)} **${category.name}**${category.existingId ? ' *(existing)*' : ''}`);
    for (const channel of category.channels) {
      const kind = channel.type === 'voice' ? '🔊' : '#️⃣';
      lines.push(`　${icon(channel.name)} ${kind} ${channel.name}`);
    }
  }
  const text = lines.join('\n');
  return text.length > 3800 ? `${text.slice(0, 3780)}\n…` : text;
}

function buttons(disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('aisetup_confirm')
        .setLabel('Create everything')
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('aisetup_cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    ),
  ];
}

export default {
  slashOnly: true,
  data: new SlashCommandBuilder()
    .setName('aisetup')
    .setDescription('AI builds categories and text/voice channels (with emojis) for your server')
    .addStringOption((option) =>
      option
        .setName('request')
        .setDescription('What kind of server is this? e.g. "gaming community with music and study rooms"')
        .setRequired(true)
        .setMaxLength(400),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  async execute(interaction) {
    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: 'This command only works in a server.', ephemeral: true });
      return;
    }

    await interaction.deferReply();
    const edit = (payload) => interaction.editReply(payload).catch((error) => {
      logger.debug(`aisetup: editReply failed: ${error?.message}`);
    });

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
      await edit({ embeds: [embed('error', 'Missing permission', 'You need the **Manage Channels** permission.')] });
      return;
    }
    if (!botCanManageChannels(guild)) {
      await edit({ embeds: [embed('error', 'I cannot do that yet', 'I need the **Manage Channels** permission. Give it to my role and run the command again.')] });
      return;
    }
    if (!isGeminiConfigured()) {
      await edit({ embeds: [embed('error', 'AI not set up', 'The bot owner needs to add a Gemini API key first.')] });
      return;
    }
    if (activeGuilds.has(guild.id)) {
      await edit({ embeds: [embed('warn', 'Already running', 'A server setup is already in progress here. Wait for it to finish.')] });
      return;
    }

    const allowed = await checkRateLimit(`aisetup:${guild.id}:${interaction.user.id}`, 3, 10 * 60 * 1000);
    if (!allowed) {
      await edit({ embeds: [embed('warn', 'Slow down', 'You can plan a setup 3 times every 10 minutes.')] });
      return;
    }

    activeGuilds.add(guild.id);
    try {
      await edit({ embeds: [embed('info', '🧠 Planning your server…', 'Looking at your server and asking the AI for a layout. This takes a few seconds.')] });

      let plan;
      try {
        plan = await requestPlan(guild, interaction.options.getString('request', true));
      } catch (error) {
        if (!error?.userMessage) logger.error('aisetup: planning failed', error);
        await edit({ embeds: [embed('error', 'Could not plan', error?.userMessage || 'Something went wrong while planning. Please try again.')] });
        return;
      }

      const skippedNote = plan.skipped.length ? `\n\n*Skipped:* ${plan.skipped.slice(0, 4).join('; ')}` : '';
      const previewMessage = await interaction.editReply({
        embeds: [embed(
          'info',
          '🗂️ Proposed layout',
          `${renderPlan(plan)}${skippedNote}`,
          `${plan.total} item(s) will be created · Buttons expire in 2 minutes`,
        )],
        components: buttons(),
      });

      let decision;
      try {
        decision = await previewMessage.awaitMessageComponent({
          componentType: ComponentType.Button,
          time: PREVIEW_TIMEOUT_MS,
          filter: (click) => {
            if (click.user.id === interaction.user.id) return true;
            click.reply({ content: 'Only the person who ran the command can use these buttons.', ephemeral: true }).catch(() => {});
            return false;
          },
        });
      } catch {
        await edit({
          embeds: [embed('warn', 'Timed out', 'No answer in 2 minutes, so nothing was created. Run `/aisetup` again when ready.')],
          components: [],
        });
        return;
      }

      if (decision.customId === 'aisetup_cancel') {
        await decision.update({
          embeds: [embed('warn', 'Cancelled', 'Nothing was created.')],
          components: [],
        });
        return;
      }

      await decision.update({ components: buttons(true) });

      // Live progress: one embed, edited as each channel is created.
      const statusByName = new Map();
      const firstPending = () => plan.categories.flatMap((c) => [c.name, ...c.channels.map((ch) => ch.name)]).find((n) => !statusByName.has(n));
      let lastEdit = 0;
      let pendingEdit = null;

      const progressEmbed = (done, results) =>
        embed(
          done ? (results.failed ? 'warn' : 'ok') : 'info',
          done ? '✅ Server setup finished' : '🔨 Building your server…',
          renderPlan(plan, statusByName),
          `${results.created} created · ${results.failed} failed · ${plan.total} planned`,
        );

      const pushProgress = async (results, force = false) => {
        const now = Date.now();
        if (!force && now - lastEdit < PROGRESS_EDIT_INTERVAL_MS) return;
        lastEdit = now;
        pendingEdit = edit({ embeds: [progressEmbed(false, results)], components: [] });
        await pendingEdit;
      };

      const running = firstPending();
      if (running) statusByName.set(running, 'run');
      await pushProgress({ created: 0, failed: 0 }, true);

      const results = await applyPlan(guild, plan, async (step, totals) => {
        statusByName.set(step.label, step.status);
        const next = firstPending();
        if (next) statusByName.set(next, 'run');
        await pushProgress(totals);
      });

      if (pendingEdit) await pendingEdit;
      const failures = results.steps.filter((s) => s.status === 'fail');
      const failureText = failures.length
        ? `\n\n**Problems:**\n${failures.slice(0, 5).map((f) => `• ${f.label}: ${f.error || 'unknown error'}`).join('\n')}`
        : '';
      const finalEmbed = progressEmbed(true, results);
      finalEmbed.setDescription(`${renderPlan(plan, statusByName)}${failureText}`.slice(0, 4000));
      await edit({ embeds: [finalEmbed], components: [] });
    } catch (error) {
      logger.error('aisetup: unexpected error', error);
      await edit({ embeds: [embed('error', 'Something went wrong', 'The setup stopped unexpectedly. Check the server channel list to see what was created.')], components: [] });
    } finally {
      activeGuilds.delete(guild.id);
    }
  },
};
