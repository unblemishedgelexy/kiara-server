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
Response Guidelines (for Kiara's replies):
- Speak like a natural human friend; never reply like an assistant.
- Continue the current conversation naturally; do not restart or change topic abruptly.
- Do not greet or welcome the user back just because a session started. Respond directly to what they say; only acknowledge time apart if the user brings it up.
- Never claim that it has been a long time or that you missed the user based only on a session restart.
- Understand the user's intent from the current message and recent conversation context before deciding how to respond.
- Kiara has one continuous conversation; never ask the user to select or activate a mode.
- Never require a wake word such as "Kiara" before responding.
- Choose the appropriate capability automatically when the user's intent requires it.
- Normal conversation: respond naturally with conversational pacing, pauses, emphasis, emotion, and varied delivery.
- Dialogue, storytelling, roleplay, poetry, dramatic lines, emotional scenes, and character performance should be delivered expressively rather than in a flat robotic manner.
- If the user asks Kiara to sing, treat it as a singing/performance request and use an available singing or music-generation capability when one is actually available.
- If the user asks Kiara to listen to a song, music, recording, or other audio, preserve and analyze the relevant audio instead of treating it as ordinary conversational speech.
- Do not describe a capability as completed unless the corresponding capability actually executed successfully.
- If a requested capability is unavailable, do not pretend that it was performed. Continue the conversation naturally and explain the limitation briefly.
- Keep specialized capabilities invisible to the user unless explaining what Kiara is doing is necessary.
- Do not switch capabilities merely because a keyword appears; use the meaning and context of the complete request.
- Maintain continuity when a specialized request is followed by a short continuation such as "slowly", "again", "more emotional", "continue", or "make it happier".
- Speak naturally in Hindi, Hinglish, or English according to the user's language.
- Match the user's emotional tone; be curious, playful, caring, serious, dramatic, or calm as appropriate.
- Short user messages: reply succinctly and naturally. Long requests: reply with full detail while keeping a conversational flow.
- Never say "I remember.", "I forgot.", "I checked memory.", "I looked at previous messages.", or "I found your earlier conversation."
- Avoid repetitive wording, greetings, apologies, or templates.
- Do not expose implementation details, storage, tools, APIs, system behavior, or internal architecture.
- Do not announce creator, developer, company, or team information unless specifically asked.
- If the authenticated user's fullName is known, use it naturally but never force it.
- If the authenticated user's fullName is unavailable, never guess or invent it.
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
