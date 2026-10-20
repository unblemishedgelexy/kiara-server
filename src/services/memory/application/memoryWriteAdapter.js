'use strict';

const { createHash } = require('crypto');
const { extract } = require('../extraction/index');
const { MemoryConsolidator } = require('../consolidation/memoryConsolidator');
const { semanticIndex } = require('../semantic/semanticIndex');
const { MemoryPersistenceError } = require('../repository/errors');
const { createWriteResult } = require('./memoryWriteAdapterContract');

const SMALL_TALK_ONLY = /^(?:(?:ha){2,}|hehe+|lol+|ok(?:ay)?|yes|no|thanks?|thank you|good morning|good night|bye|goodbye)(?:[\s,.!?]+(?:ok(?:ay)?|yes|no|haha|hehe))*[!.?]*$/i;

function safeTimestamp(value) {
  const timestamp = value ? new Date(value) : new Date();
  if (Number.isNaN(timestamp.getTime())) {
    return null;
  }
  return timestamp.toISOString();
}

function stableId(parts) {
  return `mem_${createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 40)}`;
}

function candidateId(userId, sessionId, turnId, memory, index) {
  const identity = [
    memory.type,
    memory.subject,
    memory.predicate,
    memory.value,
    memory.content,
  ].map((value) => String(value || '').trim().toLowerCase()).join('\u001e');
  return stableId([userId, sessionId, turnId, index, identity]);
}

function resolveTemporal(input, candidateTemporal, timestamp) {
  const temporal = { ...(candidateTemporal || {}) };
  if (temporal.validFrom || temporal.validUntil) {
    return { ...temporal, lastConfirmedAt: temporal.lastConfirmedAt || timestamp };
  }

  const text = String(input || '').toLowerCase();
  if (/\b(used to|previously|formerly|back then)\b/i.test(text)) {
    return { ...temporal, validUntil: timestamp, lastConfirmedAt: timestamp };
  }

  const offsetDays = /\btomorrow\b/i.test(text) ? 1
    : /\bnext week\b/i.test(text) ? 7
      : /\bnext month\b/i.test(text) ? 30
        : 0;
  if (offsetDays) {
    const validFrom = new Date(new Date(timestamp).getTime() + offsetDays * 24 * 60 * 60 * 1000);
    return { ...temporal, validFrom: validFrom.toISOString(), lastConfirmedAt: timestamp };
  }

  return { ...temporal, lastConfirmedAt: timestamp };
}

function isExtractorInfrastructureFailure(result) {
  if (result?.failureCategory) return true;
  return /failed|unavailable|timed?\s*out|could not be parsed|rate limit|api key|groq|provider|network|request error/i
    .test(String(result?.reason || ''));
}

function persistedMemories(result) {
  if (!result) return [];
  if (result.replacement || result.previous) {
    return [result.replacement, result.previous].filter(Boolean);
  }
  return [result];
}

function asPlainMemory(memory) {
  return memory && typeof memory.toJSON === 'function' ? memory.toJSON() : memory;
}

function safeErrorCategory(error) {
  return error?.name === 'MemoryPersistenceError'
    || error instanceof MemoryPersistenceError
    || error?.code === 'MONGO_FAILURE'
    ? 'MONGO_FAILURE'
    : 'CONSOLIDATION_FAILURE';
}

function isWriteConflict(error) {
  return error?.name === 'MemoryConflictError'
    || error?.cause?.name === 'MemoryConflictError'
    || error?.cause?.code === 11000;
}

function createMemoryWriteAdapter({
  extractMemory = extract,
  consolidator = new MemoryConsolidator(),
  semantic = semanticIndex,
} = {}) {
  async function saveConversationMemory({
    userId,
    sessionId,
    userMessage,
    assistantMessage,
    timestamp,
    source = 'CONVERSATION',
    options = {},
  } = {}) {
    const startedAt = Date.now();
    const safeUserId = typeof userId === 'string' ? userId.trim() : '';
    const safeSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const safeUserMessage = String(userMessage || '').trim();
    const safeAssistantMessage = String(assistantMessage || '').trim();
    const occurredAt = safeTimestamp(timestamp);

    if (!safeUserId || !safeSessionId || !safeUserMessage || !safeAssistantMessage || !occurredAt) {
      return createWriteResult('INVALID_INPUT', {
        error: { code: 'INVALID_INPUT', message: 'A user, session, complete turn, and valid timestamp are required.' },
      });
    }
    if (SMALL_TALK_ONLY.test(safeUserMessage)) {
      return createWriteResult('NO_MEMORY', {
        metadata: {
          extractionDecision: 'SKIPPED_SMALL_TALK',
          mongoStatus: 'NOT_ATTEMPTED',
          cacheStatus: 'NOT_ATTEMPTED',
          semanticIndexStatus: 'NOT_ATTEMPTED',
          latency: { totalLatencyMs: Date.now() - startedAt },
        },
      });
    }

    const suppliedTurnId = String(options.conversationTurnId || options.turnId || '').trim();
    const turnId = suppliedTurnId || stableId([
      safeUserId,
      safeSessionId,
      occurredAt,
      safeUserMessage,
      safeAssistantMessage,
    ]);
    const result = createWriteResult('NO_MEMORY');
    const latency = {};

    let extracted;
    const extractionStartedAt = Date.now();
    try {
      extracted = await extractMemory({
        userId: safeUserId,
        sessionId: safeSessionId,
        userMessage: safeUserMessage,
        assistantMessage: safeAssistantMessage,
        timestamp: occurredAt,
        sourceRole: 'user',
      });
      latency.extractionLatencyMs = Date.now() - extractionStartedAt;
    } catch (error) {
      latency.extractionLatencyMs = Date.now() - extractionStartedAt;
      return createWriteResult('EXTRACTION_FAILURE', {
        error: { code: 'EXTRACTION_FAILURE', message: 'Canonical memory extraction is temporarily unavailable.' },
        metadata: {
          turnId,
          extractionDecision: 'THREW',
          extractionFailureCode: error?.code || error?.name || 'MEMORY_EXTRACTION_FAILURE',
          mongoStatus: 'NOT_ATTEMPTED',
          cacheStatus: 'NOT_ATTEMPTED',
          semanticIndexStatus: 'NOT_ATTEMPTED',
          latency: { ...latency, totalLatencyMs: Date.now() - startedAt },
        },
      });
    }

    if (!extracted || extracted.ok === false || !Array.isArray(extracted.candidates) || extracted.candidates.length === 0) {
      const status = isExtractorInfrastructureFailure(extracted) ? 'EXTRACTION_FAILURE' : 'NO_MEMORY';
      return createWriteResult(status, {
        ...(status === 'EXTRACTION_FAILURE'
          ? { error: { code: status, message: 'Canonical memory extraction is temporarily unavailable.' } }
          : {}),
        metadata: {
          decision: extracted?.decision || 'NO_MEMORY',
          extractionDecision: extracted?.decision || 'NO_MEMORY',
          ...(status === 'EXTRACTION_FAILURE'
            ? { extractionFailureCode: extracted?.failureCode || extracted?.failureCategory || 'MEMORY_EXTRACTION_FAILURE' }
            : {}),
          turnId,
          mongoStatus: 'NOT_ATTEMPTED',
          cacheStatus: 'NOT_ATTEMPTED',
          semanticIndexStatus: 'NOT_ATTEMPTED',
          latency: { ...latency, totalLatencyMs: Date.now() - startedAt },
        },
      });
    }

    const dryRun = options.dryRun === true;
    const savedMemories = [];
    const decisions = [];
    let cacheFailure = false;
    let semanticFailure = false;
    let consolidationFailure = false;
    let mongoFailure = false;

    for (let index = 0; index < extracted.candidates.length; index += 1) {
      const extractedCandidate = extracted.candidates[index];
      const original = asPlainMemory(extractedCandidate?.memory || extractedCandidate);
      if (!original || typeof original !== 'object') continue;

      const memory = {
        ...original,
        id: candidateId(safeUserId, safeSessionId, turnId, original, index),
        userId: safeUserId,
        source: {
          ...(original.source || {}),
          type: String(original.source?.type || source || 'CONVERSATION').toUpperCase(),
          reference: turnId,
          timestamp: occurredAt,
        },
        temporal: resolveTemporal(safeUserMessage, original.temporal, occurredAt),
        lifecycle: {
          ...(original.lifecycle || {}),
          createdAt: original.lifecycle?.createdAt || occurredAt,
          updatedAt: occurredAt,
          lastConfirmedAt: occurredAt,
        },
        provenance: {
          ...(original.provenance || {}),
          sessionId: safeSessionId,
          conversationTurnId: turnId,
          source,
          timestamp: occurredAt,
        },
      };

      let consolidation;
      const consolidationStartedAt = Date.now();
      try {
        consolidation = await consolidator.consolidate({
          userId: safeUserId,
          candidate: memory,
          options: { dryRun },
        });
      } catch (error) {
        if (error?.name === 'MemoryConflictError'
          && (error?.cause?.code === 11000 || /already exists/i.test(String(error.message || '')))) {
          decisions.push({ decision: 'DUPLICATE' });
          continue;
        }
        consolidationFailure = true;
        if (safeErrorCategory(error) === 'MONGO_FAILURE') mongoFailure = true;
        decisions.push({ decision: 'FAILURE', category: safeErrorCategory(error) });
        continue;
      }
      latency.consolidationLatencyMs = (latency.consolidationLatencyMs || 0) + Date.now() - consolidationStartedAt;
      decisions.push({ decision: consolidation?.decision || 'IGNORE' });

      if (consolidation?.decision === 'DUPLICATE') {
        continue;
      }
      if (consolidation?.decision === 'IGNORE') {
        continue;
      }
      if (dryRun) {
        continue;
      }
      if (!consolidation?.persisted || !consolidation.result) {
        if (isWriteConflict(consolidation?.error)) {
          decisions[decisions.length - 1] = { decision: 'DUPLICATE' };
          continue;
        }
        consolidationFailure = true;
        decisions[decisions.length - 1].category = 'MONGO_FAILURE';
        mongoFailure = true;
        continue;
      }
      latency.mongoPersistenceLatencyMs = (latency.mongoPersistenceLatencyMs || 0)
        + Number(consolidation.mongoLatencyMs || 0);
      latency.cacheSyncLatencyMs = (latency.cacheSyncLatencyMs || 0)
        + Number(consolidation.cacheLatencyMs || 0);

      if (consolidation.cacheWarning) {
        cacheFailure = true;
      }

      const persisted = persistedMemories(consolidation.result).map(asPlainMemory);
      savedMemories.push(...persisted.filter((item) => item && item.status !== 'SUPERSEDED'));

      if (semantic && typeof semantic.upsert === 'function') {
        for (const persistedMemory of persisted) {
          try {
            const semanticStartedAt = Date.now();
            const semanticResult = await semantic.upsert(persistedMemory);
            const semanticElapsedMs = Date.now() - semanticStartedAt;
            const embeddingLatencyMs = Number(semanticResult?.embeddingLatencyMs || 0);
            latency.semanticIndexLatencyMs = (latency.semanticIndexLatencyMs || 0) + semanticElapsedMs;
            latency.embeddingLatencyMs = (latency.embeddingLatencyMs || 0) + embeddingLatencyMs;
            latency.pineconeUpsertLatencyMs = (latency.pineconeUpsertLatencyMs || 0)
              + Math.max(0, semanticElapsedMs - embeddingLatencyMs);
          } catch {
            semanticFailure = true;
          }
        }
      } else {
        semanticFailure = true;
      }
    }

    latency.totalLatencyMs = Date.now() - startedAt;
    result.memories = savedMemories;
    result.saved = savedMemories.length > 0;
    result.metadata = {
      turnId,
      extractionDecision: extracted.decision || 'MEMORY',
      decisions,
      mongoStatus: dryRun ? 'DRY_RUN' : (savedMemories.length ? 'SUCCESS' : 'NOT_ATTEMPTED'),
      cacheStatus: dryRun ? 'NOT_ATTEMPTED' : (cacheFailure ? 'FAILURE' : 'SUCCESS'),
      semanticIndexStatus: dryRun
        ? 'NOT_ATTEMPTED'
        : (semanticFailure ? 'FAILURE' : (savedMemories.length ? 'SUCCESS' : 'NOT_ATTEMPTED')),
      latency,
    };

    if (dryRun) {
      result.status = decisions.length ? 'SUCCESS' : 'NO_MEMORY';
      result.ok = true;
      result.metadata.dryRun = true;
      return result;
    }

    if (mongoFailure && savedMemories.length) {
      return createWriteResult('PARTIAL_SUCCESS', {
        ok: true,
        saved: true,
        memories: savedMemories,
        warnings: [
          'MONGO_FAILURE',
          ...(cacheFailure ? ['CACHE_FAILURE'] : []),
          ...(semanticFailure ? ['SEMANTIC_INDEX_FAILURE'] : []),
        ],
        metadata: {
          ...result.metadata,
          mongoStatus: 'PARTIAL',
          cacheStatus: cacheFailure ? 'FAILURE' : 'SUCCESS',
          semanticIndexStatus: semanticFailure ? 'FAILURE' : 'SUCCESS',
        },
      });
    }
    if (mongoFailure) {
      return createWriteResult('MONGO_FAILURE', {
        error: { code: 'MONGO_FAILURE', message: 'Canonical memory could not be saved.' },
        memories: [],
        metadata: {
          ...result.metadata,
          mongoStatus: 'FAILED',
          cacheStatus: 'NOT_ATTEMPTED',
          semanticIndexStatus: 'NOT_ATTEMPTED',
        },
      });
    }
    if (consolidationFailure) {
      return createWriteResult('CONSOLIDATION_FAILURE', {
        error: { code: 'CONSOLIDATION_FAILURE', message: 'Canonical memory consolidation failed.' },
        memories: savedMemories,
        saved: savedMemories.length > 0,
        metadata: {
          ...result.metadata,
          mongoStatus: savedMemories.length ? 'PARTIAL' : 'FAILED',
        },
      });
    }
    if (!savedMemories.length) {
      const duplicateOnly = decisions.length > 0 && decisions.every(({ decision }) => decision === 'DUPLICATE');
      return createWriteResult(duplicateOnly ? 'DUPLICATE' : 'NO_MEMORY', {
        metadata: {
          ...result.metadata,
          mongoStatus: 'NOT_ATTEMPTED',
          cacheStatus: 'NOT_ATTEMPTED',
          semanticIndexStatus: 'NOT_ATTEMPTED',
        },
      });
    }

    const warnings = [];
    if (cacheFailure) warnings.push('CACHE_FAILURE');
    if (semanticFailure) warnings.push('SEMANTIC_INDEX_FAILURE');
    const status = warnings.length ? 'PARTIAL_SUCCESS' : 'SUCCESS';
    return createWriteResult(status, {
      ok: true,
      saved: true,
      memories: savedMemories,
      warnings,
      metadata: {
        ...result.metadata,
        cacheStatus: cacheFailure ? 'FAILURE' : 'SUCCESS',
        semanticIndexStatus: semanticFailure ? 'FAILURE' : 'SUCCESS',
      },
    });
  }

  return { saveConversationMemory };
}

const defaultAdapter = createMemoryWriteAdapter();

module.exports = {
  saveConversationMemory: defaultAdapter.saveConversationMemory,
  createMemoryWriteAdapter,
};
