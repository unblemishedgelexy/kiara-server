'use strict';

const perf = require('../../../middleware/perfCollector');

/**
 * Memory Intelligence Logger — Phase 10
 * Production: only meaningful named events.
 * Development (MEMORY_DEBUG=true): adds detail.
 * Zero noise in either mode.
 */

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function emit(tag, data) {
  const payload = typeof data === 'object' ? data : { msg: String(data) };
  try {
    console.log(`[${tag}]`, JSON.stringify({ ...payload, ts: new Date().toISOString() }));
  } catch {
    console.log(`[${tag}]`, String(payload));
  }
}

function emitError(tag, err, context = {}) {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err && err.stack ? String(err.stack) : null;
  try {
    console.error('[ERROR]', JSON.stringify({
      tag: tag || 'ERROR',
      error: message,
      stack,
      ...context,
      ts: new Date().toISOString(),
    }));
  } catch {
    console.error('[ERROR]', tag, message, stack, context);
  }
}

function recordStage(stage, durationMs, meta = {}) {
  try {
    if (perf && typeof perf.record === 'function') {
      perf.record(stage, durationMs || 0, meta);
    }
  } catch {
    // ignore perf collector failures
  }
}

function recordLongTask(task = {}) {
  try {
    if (perf && typeof perf.recordLongTask === 'function') {
      perf.recordLongTask(task);
    }
  } catch {
    // ignore perf collector failures
  }
}

function recordGemini(entry = {}) {
  try {
    if (perf && typeof perf.recordGemini === 'function') {
      perf.recordGemini(entry);
    }
  } catch {
    // ignore perf collector failures
  }
}

const counters = {
  stmUsers: 0,
  queuedPromotions: 0,
  pendingRetries: 0,
  promotionsCompleted: 0,
  embeddingFailures: 0,
  pineconeFailures: 0,
  geminiRequests: 0,
  memoryHits: 0,
  memoryMisses: 0,
};

let healthDashboardStarted = false;

function buildHealthPayload() {
  const summary = perf && typeof perf.getSummary === 'function' ? perf.getSummary() : null;
  const stageSummary = summary ? summary.stages : {};
  return {
    stmUsers: counters.stmUsers,
    queuedPromotions: counters.queuedPromotions,
    pendingRetries: counters.pendingRetries,
    promotionsCompleted: counters.promotionsCompleted,
    embeddingFailures: counters.embeddingFailures,
    pineconeFailures: counters.pineconeFailures,
    averageCompression: stageSummary.PROMOTION_COMPLETE ? stageSummary.PROMOTION_COMPLETE.avg : 0,
    averagePromotionTime: stageSummary.PROMOTION_START ? stageSummary.PROMOTION_START.avg : 0,
    averageRetrievalTime: stageSummary.LTM_RETRIEVAL ? stageSummary.LTM_RETRIEVAL.avg : 0,
    geminiRequests: counters.geminiRequests,
    memoryHits: counters.memoryHits,
    memoryMisses: counters.memoryMisses,
    ts: new Date().toISOString(),
  };
}

function startHealthDashboard() {
  if (healthDashboardStarted) return;
  healthDashboardStarted = true;
  return;
}

const logger = {
  memorySaved(userId, sessionId, turnId) {
    emit('STM_SAVE_SUCCESS', { userId, sessionId, turnId, timestamp: new Date().toISOString() });
  },

  memorySaveRequested(userId, sessionId, userMessage, aiResponse) {
    return;
  },

  memoryValidation(userId, sessionId, valid, reason = null) {
    return;
  },

  contextPreparing(userId, sessionId, charLimit) {
    return;
  },

  contextFiltering(userId, filterName, inputCount, outputCount, durationMs, removed = 0, reason = null) {
    return;
  },

  contextBuilt(userId, factCount, turnCount, charCount, estimatedTokens) {
    return;
  },

  geminiContextInjected(userId, charCount, estimatedTokens, trigger) {
    return;
  },

  factExtracted(userId, type, key, value, confidence) {
    return;
  },

  factUpdated(userId, type, key, oldValue, newValue) {
    return;
  },

  factMerged(userId, type, key, value) {
    return;
  },

  memoryRetrieved(userId, factCount, turnCount) {
    emit('MEMORY_RETRIEVED', { userId, turnCount, factCount });
  },

  promptBuilt(userId, factCount, charCount) {
    return;
  },

  contextSent(userId, charCount) {
    return;
  },

  currentTaskUpdated(userId, task, file, status) {
    return;
  },

  logPromptBuilder(userId, metadata = {}) {
    emit('MEMORY_COMPOSER', { userId, ...metadata });
    if (metadata.durationMs) {
      recordStage('MEMORY_COMPOSER', metadata.durationMs, { userId });
    }
  },

  logShortTermMemory(userId, sessionId, key, existingTurnsCount, totalTurns, ttl, saveDurationMs, status) {
    emit('STM_SAVE_SUMMARY', { userId, sessionId, key, existingTurnsCount, totalTurns, ttl, durationMs: saveDurationMs, status });
    counters.stmUsers += 1;
  },

  logMemoryDeleted(userId, target, key) {
    emit('STM_MEMORY_DELETED', { userId, target, key });
  },

  recallMatch(userId, querySnippet, key, value, confidence) {
    return;
  },

  logConversationStarted(userId, sessionId) {
    emit('STM_CONVERSATION_STARTED', { userId, sessionId });
  },

  logSnapshotPrepared(userId, sessionId, turnCount, characterCount) {
    emit('STM_SNAPSHOT_PREPARED', { userId, sessionId, turnCount, characterCount });
  },

  error(tag, err, context = {}) {
    emitError(tag, err, context);
  },

  log(tag, data) {
    emit(tag, data);
  },

  logError(tag, err, context = {}) {
    emitError(tag, err, context);
    recordStage(tag, 0, { error: err instanceof Error ? err.message : String(err), ...context });
  },

  debug(tag, data) {
    return;
  },

  logFinalContext(userId, context) {
    emit('MEMORY_COMPOSER_CONTEXT', {
      userId,
      contextSnippet: String(context).slice(0, 2000),
      contextLength: String(context).length,
    });
  },

  stmSaveStart(payload = {}) {
    emit('STM_SAVE_START', payload);
    if (typeof payload.durationMs === 'number') {
      recordStage('STM_SAVE', payload.durationMs, payload);
    }
  },

  stmSaveSuccess(payload = {}) {
    emit('STM_SAVE_SUCCESS', payload);
    if (typeof payload.durationMs === 'number') {
      recordStage('STM_SAVE', payload.durationMs, payload);
    }
  },

  stmSaveFail(payload = {}) {
    emitError('STM_SAVE_FAIL', payload.error || payload, payload);
    recordStage('STM_SAVE_FAIL', payload.durationMs || 0, payload);
  },

  promotionQueueStatus(payload = {}) {
    emit('PROMOTION_QUEUE', payload);
  },

  promotionStart(payload = {}) {
    emit('PROMOTION_START', payload);
    if (typeof payload.durationMs === 'number') {
      recordStage('PROMOTION_START', payload.durationMs, payload);
    }
  },

  memoryAnalyzer(payload = {}) {
    emit('MEMORY_ANALYZER', payload);
    if (typeof payload.durationMs === 'number') {
      recordStage('MEMORY_ANALYZER', payload.durationMs, payload);
    }
  },

  embeddingStart(payload = {}) {
    emit('EMBEDDING_START', payload);
  },

  embeddingResult(payload = {}) {
    emit('EMBEDDING_RESULT', payload);
    if (typeof payload.durationMs === 'number') {
      recordStage('EMBEDDING', payload.durationMs, payload);
    }
    if (payload.success === false) {
      counters.embeddingFailures += 1;
    }
  },

  pineconeUpsert(payload = {}) {
    emit('PINECONE_UPSERT', payload);
    if (typeof payload.durationMs === 'number') {
      recordStage('PINECONE_UPSERT', payload.durationMs, payload);
    }
    if (payload.success === false) {
      counters.pineconeFailures += 1;
    }
  },

  pineconeVerify(payload = {}) {
    emit('PINECONE_VERIFY', payload);
  },

  promotionComplete(payload = {}) {
    emit('PROMOTION_COMPLETE', payload);
    if (typeof payload.durationMs === 'number') {
      recordStage('PROMOTION_COMPLETE', payload.durationMs, payload);
    }
  },

  redisCleanup(payload = {}) {
    emit('REDIS_CLEANUP', payload);
  },

  longTermRetrieval(payload = {}) {
    emit('LTM_RETRIEVAL', payload);
    if (typeof payload.durationMs === 'number') {
      recordStage('LTM_RETRIEVAL', payload.durationMs, payload);
    }
  },

  memoryComposer(payload = {}) {
    emit('MEMORY_COMPOSER', payload);
  },

  geminiRequest(payload = {}) {
    emit('GEMINI_REQUEST', payload);
    if (typeof payload.durationMs === 'number') {
      recordStage('GEMINI_REQUEST', payload.durationMs, payload);
    }
    counters.geminiRequests += 1;
  },

  geminiResponse(payload = {}) {
    emit('GEMINI_RESPONSE', payload);
    if (typeof payload.durationMs === 'number') {
      recordStage('GEMINI_RESPONSE', payload.durationMs, payload);
    }
    if (payload.status === 'ERROR') {
      counters.memoryMisses += 1;
    }
  },

  healthDashboard(payload = {}) {
    emit('MEMORY_HEALTH_DASHBOARD', payload);
  },

  startHealthDashboard() {
    startHealthDashboard();
  },

  promotionMetrics(metrics = {}) {
    try {
      const payload = {
        queuedUsers: metrics.queuedUsers || 0,
        dueUsers: metrics.dueUsers || 0,
        promotionDurationMs: metrics.promotionDurationMs || 0,
        embeddingDurationMs: metrics.embeddingDurationMs || 0,
        pineconeDurationMs: metrics.pineconeDurationMs || 0,
        episodesPromoted: metrics.episodesPromoted || 0,
        semanticMemoriesUpdated: metrics.semanticMemoriesUpdated || 0,
        duplicatePromotionsSkipped: metrics.duplicatePromotionsSkipped || 0,
        pendingRetries: metrics.pendingRetries || 0,
        averagePromotionSize: metrics.averagePromotionSize || 0,
        compressionRatio: metrics.compressionRatio || 0,
        userId: metrics.userId || undefined,
        turnCount: metrics.turnCount || undefined,
        ts: new Date().toISOString(),
      };
      console.log('[LTM_PROMOTION_METRICS]', JSON.stringify(payload));
      recordLongTask({ type: 'promotion_metrics', ...payload });
    } catch {}
  },
};

module.exports = logger;
