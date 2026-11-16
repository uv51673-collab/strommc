// aiMemoryService.js — what the AI remembers.
//
//  * Server notes: facts/preferences staff told the bot to remember ("yaad rakho ki ...").
//    Stored per server, kept until staff forget them.
//  * Recent turns: the last messages of the conversation in each channel, INCLUDING the bot's
//    own replies and action results, so follow-ups like "ab isko bhi karo" make sense.
//
// Everything goes through the bot's normal storage (client.db). Memory must never break
// chatting, so every function swallows storage errors and returns a safe value.

import { logger } from '../utils/logger.js';
import { normalizeName } from './aiServerSetupService.js';

export const MEMORY_LIMITS = {
  maxNotes: 150,
  noteChars: 500,
  maxTurns: 30,
  turnChars: 800,
  contextTurns: 14,
  contextNotesChars: 5000,
  turnMaxAgeMs: 24 * 60 * 60 * 1000,
};

const notesKey = (guildId) => `guild:${guildId}:ai:notes`;
const turnsKey = (guildId, channelId) => `guild:${guildId}:ai:turns:${channelId}`;

// Serialise read-modify-write per key inside this process (two quick pings must not lose a note).
const chains = new Map();
function withLock(key, task) {
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  chains.set(key, next);
  next.finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  }).catch(() => {});
  return next;
}

async function readList(client, key) {
  try {
    const value = await client.db.get(key);
    return Array.isArray(value) ? value : [];
  } catch (error) {
    logger.warn(`ai memory: could not read ${key}: ${error?.message}`);
    return [];
  }
}

async function writeList(client, key, list) {
  try {
    await client.db.set(key, list);
    return true;
  } catch (error) {
    logger.warn(`ai memory: could not write ${key}: ${error?.message}`);
    return false;
  }
}

const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// ---------------------------------------------------------------- notes

export async function getNotes(client, guildId) {
  return readList(client, notesKey(guildId));
}

/** Saves a note. Returns { note, duplicate } or null when storage failed. */
export function addNote(client, guildId, text, by) {
  const cleaned = clip(text, MEMORY_LIMITS.noteChars);
  if (!cleaned) return Promise.resolve(null);
  return withLock(notesKey(guildId), async () => {
    const notes = await getNotes(client, guildId);
    const key = normalizeName(cleaned);
    const same = notes.find((n) => normalizeName(n.text) === key);
    if (same) return { note: same, duplicate: true };
    const nextId = notes.reduce((max, n) => Math.max(max, Number(n.id) || 0), 0) + 1;
    const note = { id: nextId, text: cleaned, by: clip(by, 60), at: Date.now() };
    const updated = [...notes, note].slice(-MEMORY_LIMITS.maxNotes);
    return (await writeList(client, notesKey(guildId), updated)) ? { note, duplicate: false } : null;
  });
}

/**
 * Removes notes. `query` is "all", a note number ("3" / "#3"), or words contained in the note.
 * Returns the removed notes (possibly empty), or null when storage failed.
 */
export function removeNotes(client, guildId, query) {
  const wanted = clip(query, 200);
  if (!wanted) return Promise.resolve([]);
  return withLock(notesKey(guildId), async () => {
    const notes = await getNotes(client, guildId);
    let removed;
    if (/^(all|everything|sab|saare|sabhi)$/i.test(wanted)) {
      removed = notes;
    } else if (/^#?\d+$/.test(wanted)) {
      const id = Number(wanted.replace('#', ''));
      removed = notes.filter((n) => Number(n.id) === id);
    } else {
      const key = normalizeName(wanted);
      removed = key ? notes.filter((n) => normalizeName(n.text).includes(key)) : [];
    }
    if (!removed.length) return [];
    const keep = notes.filter((n) => !removed.includes(n));
    return (await writeList(client, notesKey(guildId), keep)) ? removed : null;
  });
}

// ---------------------------------------------------------------- recent turns

/** Remembers one line of the conversation. role: 'user' | 'bot'. Never throws. */
export function recordTurn(client, guildId, channelId, role, text, who = '') {
  const cleaned = clip(text, MEMORY_LIMITS.turnChars);
  if (!cleaned || !guildId || !channelId) return Promise.resolve(false);
  return withLock(turnsKey(guildId, channelId), async () => {
    const now = Date.now();
    const turns = (await readList(client, turnsKey(guildId, channelId))).filter(
      (t) => now - (t.at ?? 0) < MEMORY_LIMITS.turnMaxAgeMs,
    );
    turns.push({ role: role === 'bot' ? 'bot' : 'user', who: clip(who, 60), text: cleaned, at: now });
    return writeList(client, turnsKey(guildId, channelId), turns.slice(-MEMORY_LIMITS.maxTurns));
  }).catch(() => false);
}

export async function getRecentTurns(client, guildId, channelId) {
  const now = Date.now();
  const turns = await readList(client, turnsKey(guildId, channelId));
  return turns
    .filter((t) => now - (t.at ?? 0) < MEMORY_LIMITS.turnMaxAgeMs)
    .slice(-MEMORY_LIMITS.contextTurns);
}

// ---------------------------------------------------------------- prompt context

/** Notes + recent turns for a prompt. Always resolves (empty memory on any problem). */
export async function loadMemory(client, guildId, channelId) {
  try {
    const [notes, turns] = await Promise.all([getNotes(client, guildId), getRecentTurns(client, guildId, channelId)]);
    let size = 0;
    const kept = [];
    // Newest notes win when the budget is tight.
    for (const note of [...notes].reverse()) {
      size += note.text.length + 8;
      if (size > MEMORY_LIMITS.contextNotesChars) break;
      kept.unshift(note);
    }
    return { notes: kept, turns };
  } catch {
    return { notes: [], turns: [] };
  }
}

/** Text block to put in front of a prompt ('' when there is nothing to remember). */
export function formatMemory(memory) {
  const parts = [];
  if (memory.notes.length) {
    parts.push(`Server notes (facts and preferences staff asked you to remember):\n${memory.notes.map((n) => `- #${n.id} ${n.text}`).join('\n')}`);
  }
  if (memory.turns.length) {
    parts.push(
      `Recent conversation in this channel (oldest first; "bot" lines are your own earlier replies):\n${memory.turns
        .map((t) => `${t.role === 'bot' ? 'bot' : t.who || 'staff'}: ${t.text}`)
        .join('\n')}`,
    );
  }
  return parts.join('\n\n');
}
