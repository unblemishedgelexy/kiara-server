'use strict';

const { classifyGroqError, generateText } = require('../../groqService');

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

function getDecisionFromCandidates(candidates) {
  const decisions = candidates.map((candidate) => String(candidate.decision || '').trim().toUpperCase());
  if (decisions.some((decision) => (
    decision === 'ERROR'
    || !['MEMORY', 'NO_MEMORY', 'UPDATE', 'SUPERSEDE', 'IGNORE'].includes(decision)
  ))) {
    return 'ERROR';
  }
  if (decisions.some((decision) => ['MEMORY', 'UPDATE', 'SUPERSEDE'].includes(decision))) {
    return 'MEMORY';
  }
  if (decisions.length > 0 && decisions.every((decision) => decision === 'IGNORE')) {
    return 'IGNORE';
  }
  return 'NO_MEMORY';
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

async function analyzeConversation(input = {}, { generateTextFn = generateText } = {}) {
  const startedAt = Date.now();
  const payload = {
    userId: input.userId,
    userMessage: input.userMessage || '',
    assistantMessage: input.assistantMessage || '',
    sessionId: input.sessionId || '',
    recentContext: Array.isArray(input.recentContext) ? input.recentContext : [],
    timestamp: input.timestamp || new Date().toISOString(),
  };

  try {
    const responseText = await generateTextFn({
      systemInstruction: buildMemoryPrompt(),
      userMessage: JSON.stringify(payload, null, 2),
      jsonMode: true,
    });

    const parsed = parseStructuredJson(responseText);
    if (!parsed || typeof parsed !== 'object') {
      return {
        candidates: [],
        decision: 'ERROR',
        failureCategory: 'INVALID_OUTPUT',
        failureCode: 'INVALID_MODEL_OUTPUT',
        reason: 'Groq response could not be parsed as JSON.',
        diagnostics: {
          stage: 'response_parsing',
          providerOperation: 'groq_memory_analysis',
          inputPresent: Boolean(payload.userMessage || payload.assistantMessage),
          responseContentPresent: Boolean(responseText),
          parsingSucceeded: false,
          validationSucceeded: false,
          durationMs: Date.now() - startedAt,
        },
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
        diagnostics: {
          stage: 'schema_validation',
          providerOperation: 'groq_memory_analysis',
          inputPresent: Boolean(payload.userMessage || payload.assistantMessage),
          responseContentPresent: true,
          parsingSucceeded: true,
          validationSucceeded: false,
          durationMs: Date.now() - startedAt,
        },
      };
    }

    const decision = getDecisionFromCandidates(candidates);
    return {
      candidates,
      decision,
      raw: parsed,
      diagnostics: {
        stage: 'extraction_complete',
        providerDecision: decision,
        candidateCount: candidates.length,
        providerOperation: 'groq_memory_analysis',
        inputPresent: Boolean(payload.userMessage || payload.assistantMessage),
        responseContentPresent: true,
        parsingSucceeded: true,
        validationSucceeded: true,
        durationMs: Date.now() - startedAt,
      },
    };
  } catch (error) {
    const providerFailure = classifyGroqError(error);
    return {
      candidates: [],
      decision: 'ERROR',
      failureCategory: 'INFRASTRUCTURE',
      failureCode: providerFailure.category,
      failureStatus: providerFailure.httpStatus,
      reason: 'Groq memory analysis failed.',
      raw: null,
      diagnostics: {
        stage: 'provider_request',
        providerOperation: 'groq_memory_analysis',
        errorClass: providerFailure.errorName,
        providerCategory: providerFailure.category,
        providerStatus: providerFailure.httpStatus,
        providerRequestId: providerFailure.requestId,
        inputPresent: Boolean(payload.userMessage || payload.assistantMessage),
        responseContentPresent: false,
        parsingSucceeded: false,
        validationSucceeded: false,
        durationMs: Date.now() - startedAt,
      },
    };
  }
}

module.exports = {
  analyzeConversation,
  buildMemoryPrompt,
  parseStructuredJson,
};
