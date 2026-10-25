'use strict';

/**
 * System Prompt Builder
 *
 * Builds the dynamic system instruction injected into the Gemini ephemeral token.
 * Delegates entirely to MemoryService.prepareContext() — no direct Redis or fact access.
 *
 * Called by geminiService.createLiveEphemeralToken() on session start.
 */

const crypto = require('node:crypto');
const MemoryService = require('../memory');

function buildTemporalContext(activeContext) {
  const timeZone = typeof activeContext?.localTimeZone === 'string'
    ? activeContext.localTimeZone
    : '';

  if (!timeZone) return '';

  let currentTime;
  try {
    currentTime = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone,
    }).format(new Date());
  } catch {
    return '';
  }

  const lines = [
    `User's current local date and time: ${currentTime} (${timeZone}).`,
    'Use this as the time reference when the user asks about the time or when time is relevant; do not announce it unnecessarily.',
  ];

  return `\n\nTime and conversation continuity:\n- ${lines.join('\n- ')}`;
}

module.exports = {

  /**
   * Build the system prompt fragment for a user.
   *
   * @param {string} userId
   * @param {Object} [options]
   * @param {string}  [options.trigger]    — 'session_start' | 'new_memory_saved' (required to build)
   * @param {number}  [options.charLimit]  — max chars to inject (default 1800)
   * @returns {Promise<{ systemPrompt: string }>}
   */
  async buildSystemPrompt(userId, options = {}) {
    const trigger = options.trigger || null;
    const charLimit = options.charLimit || 1800;
    const userQuery = options.userQuery || '';
    const sessionId = options.sessionId || userId || 'session';
    const activeContext = options.activeContext || {};
    const traceId = String(options.traceId || 'untraced');
    // Guard: only build when explicitly triggered
    if (!trigger) {
      return { systemPrompt: '' };
    }

    if (!userId) {
      return { systemPrompt: '' };
    }

    try {
      const result = await MemoryService.prepareContext(userId, {
        charLimit,
        userQuery,
        sessionId,
        activeContext,
        traceId,
      });
      const RESPONSE_GUIDELINES = `
Response Guidelines:
Reply directly and naturally in the user's language, matching their tone. Keep ordinary spoken answers concise.
Continue the conversation without repetition, forced greetings, or unsolicited follow-up questions. Do not welcome the user back or claim time has passed; only acknowledge time apart if the user brings it up. Never require a wake word or mode selection.

Use relevant authenticated context, but never invent personal facts, guess the user's name, reveal internal details, or say you checked, forgot, or remember prior conversations. Be accurate about facts and honest about capabilities: use only capabilities the app provides, never claim an action succeeded unless it did, and briefly explain when a requested capability is unavailable. Preserve intent and context across follow-up requests, including performance and audio requests.
`;

      const temporalContext = buildTemporalContext(activeContext);
      const promptParts = [
        String(result.systemPrompt || '').trim(),
        temporalContext,
        RESPONSE_GUIDELINES,
      ].filter(Boolean);
      const augmented = promptParts.join('\n\n');
      const memoryContextIncluded = result.memoryContextIncluded === true;
      const memoryContextHash = result.systemPrompt
        ? crypto.createHash('sha256').update(String(result.systemPrompt)).digest('hex').slice(0, 16)
        : null;
      return {
        systemPrompt: augmented,
        memoryRevision: result.memoryRevision || 0,
        contextMemoryRevision: result.contextMemoryRevision || result.memoryRevision || 0,
        memoryStatus: result.memoryStatus || (result.facts?.length ? 'MEMORY_FOUND' : 'NO_MEMORY'),
        memoryCount: Array.isArray(result.facts) ? result.facts.length : 0,
        memoryContextIncluded,
        memoryContextHash,
        identityStatus: result.identityStatus || 'UNKNOWN',
        errorCode: result.ok === false || result.memoryStatus === 'PARTIAL'
          ? (result.errorCode || 'MEMORY_RETRIEVAL_FAILURE')
          : null,
      };

    } catch (error) {
      throw error;
    }
  },
};
