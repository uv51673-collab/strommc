// memoryActions.js — orders about what the AI remembers: remember, forget, show_memory.
// Same entry shape as registry.js. Notes are included in every later AI prompt for this server.

import { PermissionFlagsBits } from 'discord.js';
import { cleanText } from './helpers.js';
import { addNote, removeNotes, getNotes, MEMORY_LIMITS } from '../aiMemoryService.js';

const ALL = /^(all|everything|sab|saare|sabhi)$/i;

export const MEMORY_ACTIONS = {
  remember: {
    permission: [PermissionFlagsBits.ManageGuild, 'Manage Server'],
    botPermission: false,
    risky: false,
    prompt: '{"type":"remember","text":"one clear sentence to remember, e.g. a server fact, a naming style, a rule or a preference"}  (use when staff say remember / yaad rakho / note this; the note is shown to you in later messages)',
    sanitize(item) {
      const text = cleanText(item?.text, MEMORY_LIMITS.noteChars);
      return text ? { type: 'remember', text } : 'remember: there is nothing to remember';
    },
    describe: (a) => `🧠 Remember: ${a.text}`,
    async run(a, env) {
      const saved = await addNote(env.client, env.guild.id, a.text, env.invoker.user.tag);
      if (!saved) throw new Error('I could not save that note right now');
      return saved.duplicate ? `Already remembered (#${saved.note.id})` : `Remembered as note #${saved.note.id}`;
    },
  },

  forget: {
    permission: [PermissionFlagsBits.ManageGuild, 'Manage Server'],
    botPermission: false,
    risky: (a) => ALL.test(a.query), // wiping every note asks for a Confirm
    prompt: '{"type":"forget","query":"all, a note number like 3, or words from the note"}  (removes remembered notes)',
    sanitize(item) {
      const query = cleanText(item?.query, 200);
      return query ? { type: 'forget', query } : 'forget: tell me which note to forget';
    },
    describe: (a) => `🧽 Forget ${ALL.test(a.query) ? 'ALL remembered notes' : `notes matching "${a.query}"`}`,
    async run(a, env) {
      const removed = await removeNotes(env.client, env.guild.id, a.query);
      if (removed === null) throw new Error('I could not update my notes right now');
      if (!removed.length) return `No remembered note matched "${a.query}"`;
      return `Forgot ${removed.length} note(s): ${removed.slice(0, 3).map((n) => `#${n.id}`).join(', ')}${removed.length > 3 ? '…' : ''}`;
    },
  },

  show_memory: {
    permission: [PermissionFlagsBits.ManageGuild, 'Manage Server'],
    botPermission: false,
    risky: false,
    prompt: '{"type":"show_memory"}  (lists everything you remember about this server)',
    sanitize: () => ({ type: 'show_memory' }),
    describe: () => '🧠 Show what I remember',
    async run(a, env) {
      const notes = await getNotes(env.client, env.guild.id);
      if (!notes.length) return 'I have no saved notes yet. Say "yaad rakho ..." to teach me something.';
      const shown = notes.slice(-25).map((n) => `#${n.id} ${n.text}`).join('\n');
      return `**What I remember (${notes.length} note${notes.length === 1 ? '' : 's'}):**\n${shown}`;
    },
  },
};
