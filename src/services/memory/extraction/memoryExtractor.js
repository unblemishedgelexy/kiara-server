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

async function extract(input = {}) {
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
    };
  }

  const usableText = [userMessage, assistantMessage, combined].find((item) => isSafeMessage(item));
  if (!usableText) {
    return {
      ok: false,
      decision: 'NO_MEMORY',
      candidates: [],
      reason: 'No durable user-owned memory signal detected.',
    };
  }

  const analysis = await analyzeConversation(context);
  if (analysis?.failureCategory) {
    return {
      ok: false,
      decision: 'ERROR',
      candidates: [],
      failureCategory: analysis.failureCategory,
      failureCode: analysis.failureCode || 'MEMORY_EXTRACTION_FAILURE',
      reason: analysis.reason || 'Memory extraction failed.',
    };
  }

  if (!analysis || analysis.decision === 'NO_MEMORY' || !Array.isArray(analysis.candidates) || analysis.candidates.length === 0) {
    return {
      ok: false,
      decision: 'NO_MEMORY',
      candidates: [],
      reason: analysis && analysis.reason ? analysis.reason : 'No valid memory candidates found.',
    };
  }

  const accepted = [];
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
    if (decision === 'NO_MEMORY' || decision === 'IGNORE') {
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
        decision: 'ERROR',
        candidates: [],
        failureCategory: 'INVALID_OUTPUT',
        failureCode: 'INVALID_MEMORY_CANDIDATE',
        reason: 'The extracted memory candidate failed canonical validation.',
      };
    }
  }

  if (accepted.length === 0) {
    return {
      ok: false,
      decision: 'NO_MEMORY',
      candidates: [],
      reason: 'All extracted candidates failed canonical validation.',
    };
  }

  return {
    ok: true,
    decision: 'MEMORY',
    candidates: accepted,
    reason: 'Canonical memory candidates extracted successfully.',
  };
}

module.exports = {
  extract,
  isSafeMessage,
};
