// bridgeActions.js — lets the AI set up the bot's EXISTING systems (welcome, goodbye, verification,
// tickets, logging, giveaways, auto-role) by running their own slash commands internally.
//
// Why a bridge: those commands already contain the validation, permission checks and storage
// logic. Re-implementing them would risk breaking working setups. Only an allowlist of
// setup-style commands can be reached, each command still runs its own permission check, and the
// option values are validated here against the command's real option definitions.

import { PermissionFlagsBits } from 'discord.js';
import { createMockInteraction } from '../../utils/messageAdapter.js';
import { enforceDefaultCommandPermissions } from '../../utils/permissionGuard.js';
import { getGuildConfig } from '../config/guildConfig.js';
import { cleanText, cleanMessage, findChannel, findRole } from './helpers.js';

// key = "command:subcommand" (empty subcommand for top-level commands)
export const BRIDGE_ALLOWLIST = {
  'welcome:setup': { risky: false },
  'goodbye:setup': { risky: false },
  'autorole:add': { risky: true }, // every future member gets this role
  'autorole:remove': { risky: false },
  'verification:setup': { risky: true }, // changes what new members can do
  'ticket:setup': { risky: false },
  'logging:channel': { risky: false },
  'gcreate:': { risky: false },
};

const OPTION_TYPES = { 3: 'text', 4: 'whole number', 5: 'true/false', 6: 'user', 7: 'channel', 8: 'role', 10: 'number' };
const keyOf = (command, subcommand) => `${command}:${subcommand ?? ''}`;

/** The real option list of an allowlisted command, or null when it is not loaded. */
export function schemaFor(client, command, subcommand) {
  if (!Object.hasOwn(BRIDGE_ALLOWLIST, keyOf(command, subcommand))) return null;
  const loaded = client?.commands?.get?.(command);
  if (!loaded?.data?.toJSON) return null;
  const json = loaded.data.toJSON();
  const options = subcommand
    ? (json.options ?? []).find((o) => o.type === 1 && o.name === subcommand)?.options
    : (json.options ?? []).filter((o) => o.type >= 3);
  return options ? { command: loaded, description: json.description, options } : null;
}

/** Prompt lines for Gemini, generated from the real command definitions. */
export function bridgePromptLines(client) {
  const lines = [];
  for (const key of Object.keys(BRIDGE_ALLOWLIST)) {
    const [command, subcommand] = key.split(':');
    const schema = schemaFor(client, command, subcommand || null);
    if (!schema) continue;
    const opts = schema.options
      .map((o) => `"${o.name}":"<${OPTION_TYPES[o.type] ?? 'text'}${o.required ? ', required' : ', optional'}${o.choices ? `, one of ${o.choices.map((c) => c.value).join('|')}` : ''}>"`)
      .join(',');
    lines.push(`- {"type":"run_command","command":"${command}","subcommand":${subcommand ? `"${subcommand}"` : 'null'},"options":{${opts}}}  (${cleanText(schema.description, 90)})`);
  }
  return lines;
}

const toBool = (v) => v === true || /^(true|yes|y|on|1|haan)$/i.test(String(v ?? ''));

/** Typed option reader that mimics discord.js' CommandInteractionOptionResolver. */
function typedOptions(subcommand, values) {
  const get = (name) => (name in values ? values[name] : null);
  return {
    get: (name) => (name in values ? { name, value: values[name] } : null),
    getString: get,
    getInteger: get,
    getNumber: get,
    getBoolean: get,
    getChannel: get,
    getRole: get,
    getUser: get,
    getMember: () => null,
    getSubcommand: () => subcommand ?? null,
    getSubcommandGroup: () => null,
    validateRequired: () => ({ valid: true }),
    _hoistedOptions: Object.entries(values).map(([name, value]) => ({ name, value })),
  };
}

export const BRIDGE_ACTIONS = {
  run_command: {
    permission: [PermissionFlagsBits.ManageGuild, 'Manage Server'],
    botPermission: false, // the command checks what it needs itself
    risky: (a) => Boolean(BRIDGE_ALLOWLIST[keyOf(a.command, a.subcommand)]?.risky),
    promptLines: bridgePromptLines,
    sanitize(item) {
      const command = cleanText(item?.command, 30).toLowerCase();
      const subcommand = cleanText(item?.subcommand, 30).toLowerCase() || null;
      if (!Object.hasOwn(BRIDGE_ALLOWLIST, keyOf(command, subcommand))) {
        return `command: /${command}${subcommand ? ` ${subcommand}` : ''} is not available through the AI`;
      }
      const raw = {};
      for (const [k, v] of Object.entries(item?.options && typeof item.options === 'object' ? item.options : {})) {
        if (['string', 'number', 'boolean'].includes(typeof v)) raw[String(k).slice(0, 40)] = v;
      }
      return { type: 'run_command', command, subcommand, raw, values: {} };
    },
    describe(a) {
      const shown = Object.entries(a.raw)
        .map(([k, v]) => `${k}: ${String(v).replace(/\s+/g, ' ').slice(0, 60)}`)
        .join(', ');
      return `⚙️ Run /${a.command}${a.subcommand ? ` ${a.subcommand}` : ''}${shown ? ` (${shown})` : ''}`;
    },
    async validate(a, env) {
      const label = `/${a.command}${a.subcommand ? ` ${a.subcommand}` : ''}`;
      const schema = schemaFor(env.client, a.command, a.subcommand);
      if (!schema) return `command: ${label} is not loaded`;

      const values = {};
      for (const option of schema.options) {
        const raw = a.raw[option.name];
        if (raw === undefined || raw === null || raw === '') {
          if (option.required) return `command: ${label} needs "${option.name}"`;
          continue;
        }
        switch (option.type) {
          case 3: {
            const text = cleanMessage(String(raw), 1500);
            if (option.choices && !option.choices.some((c) => String(c.value) === text)) {
              return `command: "${option.name}" must be one of ${option.choices.map((c) => c.value).join(', ')}`;
            }
            values[option.name] = text;
            break;
          }
          case 4:
          case 10: {
            const n = Number(raw);
            if (!Number.isFinite(n) || (option.type === 4 && !Number.isInteger(n))) return `command: "${option.name}" must be a number`;
            values[option.name] = n;
            break;
          }
          case 5:
            values[option.name] = toBool(raw);
            break;
          case 7: {
            const found = findChannel(env.guild, String(raw));
            if (found.error) return `command: ${found.error}`;
            values[option.name] = found.channel;
            break;
          }
          case 8: {
            const role = findRole(env.guild, String(raw));
            if (!role) return `command: no role called "${raw}"`;
            values[option.name] = role;
            break;
          }
          case 6: {
            const user = env.message.mentions.users.get(String(raw));
            if (!user) return `command: "${option.name}" must be a user you mentioned`;
            values[option.name] = user;
            break;
          }
          default:
            return `command: "${option.name}" has an unsupported type`;
        }
      }
      a.values = values;
      return null;
    },
    async run(a, env) {
      const command = env.client.commands.get(a.command);
      const guildConfig = await getGuildConfig(env.client, env.guild.id);
      const interaction = createMockInteraction(env.message, command.data, []);
      interaction.options = typedOptions(a.subcommand, a.values);

      const allowed = await enforceDefaultCommandPermissions(interaction, command, { source: 'aiBridge', guildConfig });
      if (!allowed) return `/${a.command} was blocked by its own permission check (see the message above)`;

      await command.execute(interaction, guildConfig, env.client);
      return `Ran /${a.command}${a.subcommand ? ` ${a.subcommand}` : ''} — its own reply with the details is in this channel`;
    },
  },
};
