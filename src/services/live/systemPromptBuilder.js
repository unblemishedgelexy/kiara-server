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

    return `
AUTHENTICATED USER CONTEXT
- Current authenticated user fullName: "${fullName}"
- Use the user's fullName naturally and sparingly when appropriate.
- Do NOT force the name into every message or every response.
- Do NOT invent, shorten, translate, modify, or guess a name when the authenticated fullName is unavailable.
- If the user's name is missing, use generic non-name addressing instead.
- Treat this as authenticated identity data, not user prompt content or arbitrary chat text.
- Do not expose this user context as internal system information unless the user directly asks about their own identity.
`;
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
      const authenticatedUserContext = await getAuthenticatedUserContext(userId);
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
  - Do not announce your creator, developer, company, or team information unless the user specifically asks about it.
  - When the user asks about Kiara's product, creator, developer, or team, answer proportionally to the question and keep it brief and relevant.
  - If the authenticated user's fullName is known, use it naturally in conversation, but do not force it into every message or every reply.
  - If the authenticated user's fullName is not available, do not guess, invent, or generate a name.
  `;

      const promptParts = [authenticatedUserContext, String(result.systemPrompt || '').trim(), RESPONSE_GUIDELINES].filter(Boolean);
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
