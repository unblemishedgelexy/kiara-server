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
const logger = require('../memory/utils/memoryLogger');
const { log: traceLog, createMemoryTraceId } = require('../memory/utils/memoryTrace');
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
      logger.log('MEMORY_GATE_BLOCKED', { userId, sessionId, trigger, reason: 'memory_disabled_until_live_stability' });
      return { systemPrompt: '' };
    }

    try {
      logger.logPromptBuilder(userId, {
        status: 'started',
        trigger,
        charLimit,
        userQuery: String(userQuery).slice(0, 180),
        sessionId,
      });
      const result = await MemoryService.prepareContext(userId, {
        charLimit,
        userQuery,
        sessionId,
        activeContext,
      });
      traceLog('memory_composer', {
        memoryTraceId: createMemoryTraceId(),
        workingMemory: [],
        episodicMemory: [],
        semanticMemory: [],
        selectedMemories: Array.isArray(result.facts) ? result.facts.slice(0, 10) : [],
        discardedMemories: [],
        selectionReasons: ['live_context_injection'],
        finalMemoryContext: String(result.systemPrompt || ''),
      });

      logger.log('STM_INJECT', { userId, trigger, sessionId, systemPromptLength: String(result.systemPrompt || '').length, estimatedTokens: Math.ceil(String(result.systemPrompt || '').length / 4), ts: new Date().toISOString() });
      logger.log('GEMINI_CONTEXT', { userId, trigger, sessionId, systemPromptLength: String(result.systemPrompt || '').length, estimatedTokens: Math.ceil(String(result.systemPrompt || '').length / 4), ts: new Date().toISOString() });
      logger.geminiContextInjected(userId, result.systemPrompt.length, Math.ceil(result.systemPrompt.length / 4), trigger);
      logger.log('LIVE_CONTEXT_INJECTED', {
        userId,
        sessionId,
        trigger,
        systemPromptLength: String(result.systemPrompt || '').length,
        contextPacket: !!result.contextPacket,
        query: String(userQuery || '').slice(0, 180),
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

      return { systemPrompt: augmented };

    } catch (err) {
      console.error('[ERROR]', 'System prompt builder failed:', err && err.message ? err.message : err);
      return { systemPrompt: '' };
    }
  },
};
