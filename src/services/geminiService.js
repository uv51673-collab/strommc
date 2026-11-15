// geminiService.js — answers staff questions through the Google Gemini API.
//
// Config (all via .env):
//   GEMINI_API_KEY           required; if empty the AI feature is simply disabled
//   GEMINI_MODEL             optional; main model, defaults to DEFAULT_MODEL below
//   GEMINI_FALLBACK_MODELS   optional; comma-separated backup models tried when the main model is
//                            overloaded (503), too slow, rate limited (429) or missing (404).
//                            Set it to an empty value to turn the fallbacks off.
//   GEMINI_THINKING_LEVEL    optional; minimal|low|medium|high for every model, or "default" to send
//                            nothing. Lower = faster answers. Unset = a sensible level per model.
//   GEMINI_TIMEOUT_MS        optional; timeout of ONE request (default 15000)
//   GEMINI_TOTAL_TIMEOUT_MS  optional; budget for a whole question incl. retries (default 45000)
//   GEMINI_RETRY_DELAY_MS    optional; wait before the 1st retry, doubles for the 2nd (default 1500)
//   BOT_DISPLAY_NAME         optional; name the AI uses for itself (default "Strommc bot")
//
// Google sometimes answers 503 ("high demand") or is slow. Those are temporary, so the
// question is retried automatically, switching to a backup model first (each model has its
// own capacity). A wrong/blocked API key (400/401/403) is never retried.

import { logger } from '../utils/logger.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.8-flash';
// Stable models from Google's model list. The main model goes first; the others are tried
// in this order when it fails (a model that is already the main one is not repeated).
// How hard each model "thinks" before answering (per Google's thinking guide). Less thinking = faster.
// gemini-3.8-flash defaults to "medium" and rejects "minimal", so it gets "low"; gemini-3.6-flash accepts
// "minimal"; the flash-lite models already default to "minimal". Custom model names send nothing.
const THINKING_LEVELS = {
  'gemini-3.8-flash': 'low',
  'gemini-3.6-flash': 'minimal',
};
const DEFAULT_FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash'];
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_TOTAL_TIMEOUT_MS = 45000;
const DEFAULT_RETRY_DELAY_MS = 1500;
const MAX_ATTEMPTS = 3;
const MIN_USEFUL_ATTEMPT_MS = 3000;
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
const DISCORD_MESSAGE_LIMIT = 2000;
const MAX_QUESTION_LENGTH = 1500;

export function getBotDisplayName() {
  return process.env.BOT_DISPLAY_NAME?.trim() || 'Strommc bot';
}

export function isGeminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

function buildSystemInstruction() {
  return [
    `You are ${getBotDisplayName()}, a helpful assistant that lives inside a Discord server.`,
    'You are answering a question from a staff member.',
    'Reply in the same language the user wrote in (including Hinglish if they use it).',
    'Answer directly with no preamble or filler. Keep it short: usually 2-5 sentences, under 600 characters.',
    'Only go longer when the question truly needs detail, and never above 1500 characters.',
    'Use plain Discord-friendly markdown. Never mention @everyone or @here.',
    'If you do not know something, say so instead of guessing.',
  ].join(' ');
}

/**
 * Split text into chunks that fit in a Discord message, preferring line breaks.
 */
export function splitForDiscord(text, limit = DISCORD_MESSAGE_LIMIT) {
  const chunks = [];
  let remaining = String(text ?? '').trim();

  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) {
      cut = remaining.lastIndexOf(' ', limit);
    }
    if (cut < limit * 0.5) {
      cut = limit;
    }
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// retryable: temporary problem, the same model may work again shortly.
// skipModel: this model will not work for this question (missing / rate limited), but another one might.
function userError(message, userMessage, { retryable = false, skipModel = false, cause } = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.userMessage = userMessage;
  error.retryable = retryable;
  error.skipModel = skipModel;
  return error;
}

function getThinkingLevel(model) {
  const override = process.env.GEMINI_THINKING_LEVEL?.trim().toLowerCase();
  if (override) {
    return override === 'default' ? undefined : override;
  }
  return THINKING_LEVELS[model];
}

function getModelList() {
  const primary = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  const rawFallbacks = process.env.GEMINI_FALLBACK_MODELS;
  const fallbacks =
    rawFallbacks === undefined
      ? DEFAULT_FALLBACK_MODELS
      : rawFallbacks.split(',').map((name) => name.trim()).filter(Boolean);
  return [...new Set([primary, ...fallbacks])];
}

/**
 * One single request to Gemini. Throws an error with `userMessage` and `retryable`.
 */
async function requestOnce({ apiKey, model, prompt, timeoutMs, thinkingLevel }) {
  let response;
  try {
    response = await fetch(`${API_BASE}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: buildSystemInstruction() }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        // Newer Gemini models "think" first and thinking tokens count towards this limit.
        generationConfig: {
          maxOutputTokens: 2048,
          temperature: 0.7,
          ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const timedOut = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
    logger.warn(`Gemini request failed (${timedOut ? 'timeout' : cause?.message || 'network error'})`);
    throw userError(
      'Gemini request failed',
      timedOut
        ? 'The AI took too long to answer. Please try again.'
        : 'I could not reach the AI service. Please try again in a moment.',
      { retryable: true, cause },
    );
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // Non-JSON body; handled below.
  }

  if (!response.ok) {
    const apiMessage = data?.error?.message || response.statusText;
    logger.warn(`Gemini API error ${response.status} (model: ${model}): ${apiMessage}`);

    let userMessage;
    if (response.status === 429) {
      userMessage = 'The AI is busy right now (rate limit). Please try again shortly.';
    } else if (response.status === 503) {
      userMessage = 'The AI is under heavy load right now. Please try again in a moment.';
    } else if (response.status === 400 || response.status === 401 || response.status === 403) {
      userMessage = 'The AI key looks invalid or not allowed. Ask the bot owner to check it.';
    } else if (response.status === 404) {
      userMessage = 'The configured AI model was not found. Ask the bot owner to check GEMINI_MODEL.';
    } else {
      userMessage = 'The AI service had a problem. Please try again in a moment.';
    }
    const error = userError(`Gemini API error ${response.status}: ${apiMessage}`, userMessage, {
      retryable: RETRYABLE_STATUS.has(response.status),
      skipModel: response.status === 404 || response.status === 429,
    });
    // A 400 about the thinking setting is not a key problem: the caller retries without it.
    error.thinkingRejected = Boolean(thinkingLevel) && response.status === 400 && /think/i.test(apiMessage);
    throw error;
  }

  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((part) => part?.text ?? '')
    .join('')
    .trim();

  if (!text) {
    const blocked = data?.promptFeedback?.blockReason || candidate?.finishReason;
    logger.warn(`Gemini returned no text (reason: ${blocked || 'unknown'})`);
    throw userError(
      'Gemini returned an empty response',
      'I could not come up with an answer for that. Try rephrasing your question.',
    );
  }

  return text;
}

/**
 * Ask Gemini a question. Returns the answer text.
 * Temporary failures (503/500/502/504, timeouts, network errors) are retried automatically.
 * Throws an Error with a user-safe `userMessage` on failure; the API key is never logged.
 */
export async function askGemini(question) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw userError(
      'GEMINI_API_KEY is not set',
      'AI is not configured yet. Ask the bot owner to add the Gemini API key.',
    );
  }

  const prompt = String(question ?? '').trim().slice(0, MAX_QUESTION_LENGTH);
  if (!prompt) {
    throw userError('Empty question', 'Please ask me a question.');
  }

  const models = getModelList();
  const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const totalMs = Number(process.env.GEMINI_TOTAL_TIMEOUT_MS) || DEFAULT_TOTAL_TIMEOUT_MS;
  const baseDelayMs = Number(process.env.GEMINI_RETRY_DELAY_MS) || DEFAULT_RETRY_DELAY_MS;

  const startedAt = Date.now();
  const remainingMs = () => totalMs - (Date.now() - startedAt);

  // With backup models: two full rounds over them. With a single model: MAX_ATTEMPTS tries.
  const maxRequests = models.length === 1 ? MAX_ATTEMPTS : models.length * 2;
  const unusableModels = new Set(); // 404 / 429 for this question: do not ask them again
  const withoutThinkingConfig = new Set(); // models that rejected the thinking setting

  let requests = 0;
  let pos = 0; // position inside the current round over the usable models
  let rounds = 0; // completed rounds
  let roundHadTemporaryFailure = false;
  let lastError;

  while (requests < maxRequests && remainingMs() >= MIN_USEFUL_ATTEMPT_MS) {
    const usable = models.filter((name) => !unusableModels.has(name));
    if (usable.length === 0) {
      break;
    }
    if (pos >= usable.length) {
      pos = 0;
    }

    const model = usable[pos];
    pos++;
    requests++;

    try {
      const text = await requestOnce({
        apiKey,
        model,
        prompt,
        timeoutMs: Math.min(timeoutMs, remainingMs()),
        thinkingLevel: withoutThinkingConfig.has(model) ? undefined : getThinkingLevel(model),
      });
      if (requests > 1) {
        logger.info(`Gemini answered with model ${model} (request ${requests})`);
      }
      return text;
    } catch (error) {
      lastError = error;

      if (error.thinkingRejected && !withoutThinkingConfig.has(model) && requests < maxRequests) {
        logger.warn(`Gemini model ${model} rejected thinking level; retrying it without that setting`);
        withoutThinkingConfig.add(model);
        pos--; // ask the same model again, this time without the thinking setting
        continue;
      }

      if (error.skipModel && !error.retryable) {
        unusableModels.add(model);
        pos--; // the next model moved into this slot
      } else if (error.retryable) {
        roundHadTemporaryFailure = true;
      } else {
        throw error; // wrong key, empty answer, etc. — another model will not help
      }

      const stillUsable = models.filter((name) => !unusableModels.has(name));
      if (stillUsable.length === 0 || requests >= maxRequests) {
        throw error;
      }

      // Switching to another model needs no waiting; wait only after a full round of them.
      if (pos >= stillUsable.length) {
        const delayMs = baseDelayMs * 2 ** rounds;
        rounds++;
        pos = 0;
        if (roundHadTemporaryFailure) {
          if (remainingMs() < delayMs + MIN_USEFUL_ATTEMPT_MS) {
            throw error;
          }
          logger.info(`All Gemini models busy, retrying in ${delayMs}ms (request ${requests + 1}/${maxRequests})`);
          await sleep(delayMs);
        }
        roundHadTemporaryFailure = false;
      }
    }
  }

  throw lastError ?? userError('Gemini request failed', 'The AI took too long to answer. Please try again.');
}
