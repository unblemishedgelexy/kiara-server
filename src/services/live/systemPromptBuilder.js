'use strict';

/**
 * System Prompt Builder
 *
 * Builds the dynamic system instruction injected into the Gemini ephemeral token.
 * Delegates entirely to MemoryService.prepareContext() — no direct Redis or fact access.
 *
 * Called by geminiService.createLiveEphemeralToken() on session start.
 */

const MemoryService = require('../memory');
const { isMemoryEligible } = require('../memory/memoryStabilityGate');

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
    const trigger   = options.trigger   || null;
    const charLimit = options.charLimit || 1800;
    const userQuery = options.userQuery || '';
    const sessionId = options.sessionId || userId || 'session';
    const activeContext = options.activeContext || {};

    // Guard: only build when explicitly triggered
    if (!trigger) {
      return { systemPrompt: '' };
    }

    if (!userId) {
      return { systemPrompt: '' };
    }

    if (!isMemoryEligible(userId, sessionId)) {
      return { systemPrompt: '' };
    }

    try {
      const result = await MemoryService.prepareContext(userId, {
        charLimit,
        userQuery,
        sessionId,
        activeContext,
      });
      const RESPONSE_GUIDELINES = `
  Response Guidelines (for Kiara's replies):
  - Speak like a natural human friend; never reply like an assistant.
  - Continue the current conversation naturally; do not restart or change topic abruptly.
  - Use recent conversational context and facts seamlessly; do not indicate where you got them.
  - Never say any of these phrases: "I remember.", "I forgot.", "I checked memory.", "I looked at previous messages.", "I found your earlier conversation.".
  - Avoid repetitive wording, greetings, apologies, or templates; if similar content was used recently, rephrase naturally.
  - Match the user's emotional tone; be curious, playful, caring, or serious as appropriate.
  - Short user messages: reply succinctly and naturally. Long requests: reply with full detail while keeping a conversational flow.
  - Do not expose implementation details, storage, or system behavior. Do not mention STM, Redis, logs, or system internals.
  - When asking follow-ups, only ask what is needed and only if the information isn't already evident from the conversation.
  - Avoid scripted lines; prefer varied natural language and small human-like acknowledgments.
  `;

      const augmented = String(result.systemPrompt || '').trim()
        ? `${result.systemPrompt}\n\n${RESPONSE_GUIDELINES}`
        : RESPONSE_GUIDELINES;

      return {
        systemPrompt: augmented,
        memoryRevision: result.memoryRevision || 0,
        contextMemoryRevision: result.contextMemoryRevision || result.memoryRevision || 0,
      };

    } catch {
      return { systemPrompt: '' };
    }
  },
};
