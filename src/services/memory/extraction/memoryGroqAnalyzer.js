'use strict';

const { generateText } = require('../../groqService');

function stripMarkdownCodeFence(value) {
  if (typeof value !== 'string') {
    return value;
  }
  return value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

function parseStructuredJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    const trimmed = stripMarkdownCodeFence(value);
    try {
      return JSON.parse(trimmed);
    } catch (innerError) {
      return null;
    }
  }
}

function buildMemoryPrompt() {
  return `
You are the memory-intelligence classifier for Kiara.
Your job is to identify durable, user-owned information that may become a canonical memory candidate.
Do not treat small talk or generic social chatter as memory.
Return only valid JSON.
The JSON root must contain an array named "candidates".
Each item must have:
- "decision": one of "MEMORY", "NO_MEMORY", "UPDATE", "SUPERSEDE", "IGNORE"
- "memory": an object with canonical Kiara memory fields if decision is MEMORY or UPDATE
- "reason": brief machine-readable reason
- "confidence": numeric 0-1 value
- "importance": one of "HIGH", "MEDIUM", "LOW"

Canonical types are exactly: identity, preference, goal, project, fact, relationship, habit, decision, event, episode.
If the message is not durable or memory-worthy, return {"candidates": [{"decision":"NO_MEMORY","reason":"not durable","confidence":0.0,"importance":"LOW"}]}
Rules:
- Only user-authored factual statements become strong memory candidates.
- Assistant statements are not authoritative user memory unless clearly attributed to the user.
- Do not invent missing facts or dates.
- Prefer conservative extraction: only return MEMORY when the evidence is strong.
- For generic greetings, small talk, or yes/no answers, return NO_MEMORY.
- For historical or temporal statements, keep the temporal meaning only if explicit in the text.
- For assistant inference, use a lower confidence and explicit provenance.
Return valid JSON with no markdown fences.
`.trim();
}

async function analyzeConversation(input = {}) {
  const payload = {
    userId: input.userId,
    userMessage: input.userMessage || '',
    assistantMessage: input.assistantMessage || '',
    sessionId: input.sessionId || '',
    recentContext: Array.isArray(input.recentContext) ? input.recentContext : [],
    timestamp: input.timestamp || new Date().toISOString(),
  };

  try {
    const responseText = await generateText({
      systemInstruction: buildMemoryPrompt(),
      userMessage: JSON.stringify(payload, null, 2),
    });

    const parsed = parseStructuredJson(responseText);
    if (!parsed || typeof parsed !== 'object') {
      return {
        candidates: [],
        decision: 'ERROR',
        failureCategory: 'INVALID_OUTPUT',
        failureCode: 'INVALID_MODEL_OUTPUT',
        reason: 'Groq response could not be parsed as JSON.',
      };
    }

    const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
    if (!Array.isArray(parsed.candidates)
      || candidates.some((candidate) => !candidate || typeof candidate !== 'object' || Array.isArray(candidate) || typeof candidate.decision !== 'string')) {
      return {
        candidates: [],
        decision: 'ERROR',
        failureCategory: 'INVALID_OUTPUT',
        failureCode: 'INVALID_MODEL_OUTPUT',
        reason: 'Groq response did not match the expected candidate schema.',
      };
    }

    return {
      candidates,
      decision: candidates.length ? 'MEMORY' : 'NO_MEMORY',
      raw: parsed,
    };
  } catch (error) {
    return {
      candidates: [],
      decision: 'ERROR',
      failureCategory: 'INFRASTRUCTURE',
      failureCode: error?.code || error?.name || 'GROQ_ANALYSIS_FAILURE',
      reason: error && error.message ? error.message : 'Groq memory analysis failed.',
      raw: null,
    };
  }
}

module.exports = {
  analyzeConversation,
  buildMemoryPrompt,
  parseStructuredJson,
};
