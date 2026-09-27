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
const User = require('../../models/User');
const { isMemoryEligible } = require('../memory/memoryStabilityGate');

function normalizeUserFullName(user = null) {
  if (!user || typeof user !== 'object') {
    return '';
  }

  const directFullName = String(user.fullName || '').trim();
  if (directFullName) {
    return directFullName;
  }

  const firstName = String(user.firstName || '').trim();
  const lastName = String(user.lastName || '').trim();
  const displayName = String(user.displayName || '').trim();

  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
  return fullName || displayName;
}

async function getAuthenticatedUserContext(userId) {
  if (!userId) {
    return '';
  }

  try {
    const user = await User.findById(userId).select('firstName lastName displayName fullName');
    const fullName = normalizeUserFullName(user);

    if (!fullName) {
      return '';
    }

    return '';
  } catch {
    return '';
  }
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
      const authenticatedUserContext = await getAuthenticatedUserContext(userId);
      const RESPONSE_GUIDELINES = `
Response Guidelines (for Kiara's replies):
- Speak like a natural human friend; never reply like an assistant.
- Continue the current conversation naturally; do not restart or change topic abruptly.
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

      const promptParts = [String(result.systemPrompt || '').trim(), RESPONSE_GUIDELINES].filter(Boolean);
      const augmented = promptParts.join('\n\n');
      const resolvedUser = await User.findById(userId).select('firstName lastName displayName');
      const resolvedFullName = normalizeUserFullName(resolvedUser);

      return {
        systemPrompt: augmented,
        memoryRevision: result.memoryRevision || 0,
        contextMemoryRevision: result.contextMemoryRevision || result.memoryRevision || 0,
        userFullName: resolvedFullName || null,
        userFullNamePresent: Boolean(resolvedFullName),
      };

    } catch {
      return { systemPrompt: '' };
    }
  },
};
