// repliedMessageService.js — when staff reply to a message and ping the bot ("isko #rewards me
// bhej do"), the bot needs to read the message that was replied to.

const MAX_REPLIED_CHARS = 3500;

function embedText(embed) {
  const parts = [embed.title, embed.description];
  for (const field of embed.fields ?? []) {
    parts.push(`${field.name}: ${field.value}`);
  }
  if (embed.footer?.text) parts.push(embed.footer.text);
  return parts.filter(Boolean).join('\n');
}

/** Plain-text version of a message: its text, its embeds and its attachment names. */
export function messageToText(referenced) {
  const parts = [];
  if (referenced.content) parts.push(referenced.content);
  for (const embed of referenced.embeds ?? []) {
    const text = embedText(embed);
    if (text) parts.push(text);
  }
  const files = [...(referenced.attachments?.values?.() ?? [])].map((a) => a.name || a.url).filter(Boolean);
  if (files.length) parts.push(`[attachments: ${files.slice(0, 5).join(', ')}]`);
  return parts.join('\n\n').trim();
}

/**
 * Returns { author, text } for the message that `message` replies to, or null
 * (not a reply, deleted, not readable, or empty).
 */
export async function getRepliedMessage(message) {
  if (!message?.reference?.messageId) return null;
  try {
    const referenced = await message.fetchReference();
    const text = messageToText(referenced).slice(0, MAX_REPLIED_CHARS);
    if (!text) return null;
    return { author: referenced.author?.tag ?? referenced.author?.username ?? 'someone', text };
  } catch {
    return null;
  }
}

/** Adds the replied message to a question/instruction so the AI can see what "this" means. */
export function withRepliedMessage(text, replied) {
  if (!replied) return text;
  return `${text}\n\n[The staff member replied to this message by ${replied.author}:]\n${replied.text}`;
}
