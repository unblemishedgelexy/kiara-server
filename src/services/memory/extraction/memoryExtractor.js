'use strict';

const { assertDecision } = require('./extractionContract');
const { classifyMemoryType, normalizeMemoryType } = require('./memoryClassifier');
const { normalizeCandidate } = require('./memoryNormalizer');
const { analyzeConversation } = require('./memoryGroqAnalyzer');

function isSafeMessage(text) {
  const value = String(text || '').trim();
  if (!value) {
    return false;
  }
  const lower = value.toLowerCase();
  const noMemorySignals = /^(hi|hello|hey|hii|ok|okay|yes|no|haha|hehe|lol|thanks|thank you|good morning|good night|goodbye|bye|how are you|what are you doing)$/i;
  if (noMemorySignals.test(lower)) {
    return false;
  }
  if (lower.length < 5) {
    return false;
  }
  return true;
}

function flattenInput(input = {}) {
  const userMessage = String(input.userMessage || '').trim();
  const assistantMessage = String(input.assistantMessage || '').trim();
  const recentContext = Array.isArray(input.recentContext) ? input.recentContext : [];
  const combined = [userMessage, assistantMessage].concat(recentContext.map((entry) => String(entry || '').trim())).filter(Boolean).join(' ');
  return { userMessage, assistantMessage, combined };
}

async function extract(input = {}, { analyzeConversationFn = analyzeConversation } = {}) {
  const { userMessage, assistantMessage, combined } = flattenInput(input);
  const context = {
    userId: input.userId,
    userMessage,
    assistantMessage,
    sourceRole: input.sourceRole || 'user',
    sessionId: input.sessionId,
    recentContext: Array.isArray(input.recentContext) ? input.recentContext : [],
    timestamp: input.timestamp || new Date().toISOString(),
  };

  if (!input.userId) {
    return {
      ok: false,
      decision: 'NO_MEMORY',
      candidates: [],
      reason: 'Missing userId',
      reasonCode: 'MISSING_USER_ID',
    };
  }

  const usableText = [userMessage, assistantMessage, combined].find((item) => isSafeMessage(item));
  if (!usableText) {
    return {
      ok: false,
      decision: 'NO_MEMORY',
      candidates: [],
      reason: 'No durable user-owned memory signal detected.',
      reasonCode: 'INPUT_SCREEN_NO_MEMORY',
      diagnostics: {
        stage: 'input_screen',
        providerOperation: 'groq_memory_analysis',
        inputPresent: Boolean(userMessage || assistantMessage),
        responseContentPresent: false,
        parsingSucceeded: false,
        validationSucceeded: false,
      },
    };
  }

  const analysis = await analyzeConversationFn(context);
  if (analysis?.failureCategory) {
    return {
      ok: false,
      decision: 'ERROR',
      candidates: [],
      failureCategory: analysis.failureCategory,
      failureCode: analysis.failureCode || 'MEMORY_EXTRACTION_FAILURE',
      reason: analysis.reason || 'Memory extraction failed.',
      diagnostics: analysis.diagnostics,
    };
  }

  if (!analysis) {
    return {
      ok: false,
      decision: 'ERROR',
      candidates: [],
      failureCategory: 'INVALID_OUTPUT',
      failureCode: 'EMPTY_ANALYSIS_RESULT',
      reason: 'Memory analysis returned no result.',
    };
  }

  if (analysis.decision === 'NO_MEMORY'
    && Array.isArray(analysis.candidates)
    && analysis.candidates.length === 0) {
    return {
      ok: false,
      decision: 'NO_MEMORY',
      candidates: [],
      reason: analysis && analysis.reason ? analysis.reason : 'No valid memory candidates found.',
      reasonCode: 'PROVIDER_NO_MEMORY',
      diagnostics: analysis.diagnostics,
    };
  }

  if (!Array.isArray(analysis.candidates) || analysis.candidates.length === 0) {
    return {
      ok: false,
      decision: 'ERROR',
      candidates: [],
      failureCategory: 'INVALID_OUTPUT',
      failureCode: 'INVALID_CANDIDATE_RESULT',
      reason: 'Memory analysis did not return candidate results.',
    };
  }

  const accepted = [];
  let ignoredCandidate = false;
  for (const candidate of analysis.candidates) {
    const decision = candidate && candidate.decision ? String(candidate.decision).trim().toUpperCase() : 'NO_MEMORY';
    if (decision === 'ERROR') {
      return {
        ok: false,
        decision: 'ERROR',
        candidates: [],
        failureCategory: 'INVALID_OUTPUT',
        failureCode: 'MODEL_DECISION_ERROR',
        reason: candidate.reason || 'The memory extractor returned an error decision.',
      };
    }
    if (decision === 'NO_MEMORY') {
      continue;
    }
    if (decision === 'IGNORE') {
      ignoredCandidate = true;
      continue;
    }

    try {
      assertDecision(decision);
    } catch {
      return {
        ok: false,
        decision: 'ERROR',
        candidates: [],
        failureCategory: 'INVALID_OUTPUT',
        failureCode: 'UNSUPPORTED_EXTRACTION_DECISION',
        reason: 'The memory extractor returned an unsupported decision.',
      };
    }

    const rawMemory = candidate.memory || candidate;
    const inferredType = normalizeMemoryType(rawMemory.type || rawMemory.category || classifyMemoryType(usableText) || 'fact');
    if (!inferredType) {
      return {
        ok: false,
        decision: 'ERROR',
        candidates: [],
        failureCategory: 'INVALID_OUTPUT',
        failureCode: 'UNSUPPORTED_MEMORY_TYPE',
        reason: 'The memory extractor returned an unsupported memory type.',
      };
    }

    try {
      const normalized = normalizeCandidate({
        ...rawMemory,
        type: inferredType,
        content: rawMemory.content || rawMemory.summary || usableText,
        confidence: rawMemory.confidence || { value: 0.7, label: 'MEDIUM' },
        importance: rawMemory.importance || 'MEDIUM',
      }, { ...context, sourceRole: input.sourceRole || 'user' });

      accepted.push({
        decision,
        reason: candidate.reason || 'memory candidate accepted',
        memory: normalized,
      });
    } catch {
      return {
        ok: false,
        decision: 'CANDIDATES_REJECTED',
        candidates: [],
        reason: 'The extracted memory candidate failed canonical validation.',
      };
    }
  }

  if (accepted.length === 0) {
    return {
      ok: false,
      decision: ignoredCandidate ? 'NO_OP' : 'NO_MEMORY',
      candidates: [],
      reason: ignoredCandidate
        ? 'The extractor intentionally ignored all candidates.'
        : 'The extractor decided there was no memory to save.',
      reasonCode: ignoredCandidate ? 'ALL_CANDIDATES_IGNORED' : 'ALL_CANDIDATES_NO_MEMORY',
      diagnostics: analysis.diagnostics,
    };
  }

  return {
    ok: true,
    decision: 'MEMORY',
    candidates: accepted,
    reason: 'Canonical memory candidates extracted successfully.',
    diagnostics: analysis.diagnostics,
  };
}

module.exports = {
  extract,
  isSafeMessage,
};
