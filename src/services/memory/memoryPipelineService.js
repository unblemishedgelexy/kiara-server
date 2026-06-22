const { env } = require('../../config/env');
const memoryExtractor = require('./memoryExtractorService');
const memoryFilterService = require('./memoryFilterService');
const memoryImportanceService = require('./memoryImportanceService');
const memoryStorageService = require('./memoryStorageService');
const memoryMetricsService = require('./memoryMetricsService');
const redisService = require('../infrastructure/redisService');
const conversationStateService = require('./conversationStateService');
const sessionMemoryService = require('./sessionMemoryService');
const memoryProfileService = require('./memoryProfileService');
const sessionBootstrapService = require('./sessionBootstrapService');
const pineconeService = require('../pineconeService');
const memoryJobService = require('./memoryJobService');
const unfinishedContextService = require('./unfinishedContextService');
const promotionQueueService = require('./promotionQueueService');
const memoryIsolationValidator = require('./memoryIsolationValidator');
const memoryIntakeService = require('./memoryIntakeService');

const DEEP_MEMORY_CATEGORIES = ['identity', 'project', 'goal', 'relationship', 'fact'];

function createTraceEvent(step, details = {}) {
  return {
    timestamp: new Date().toISOString(),
    step,
    details,
  };
}

function normalizeTextForEmbedding(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function createTextEmbedding(text, dimension = env.pineconeVectorDimension || 1536) {
  const normalized = normalizeTextForEmbedding(text);
  const vector = new Array(dimension).fill(0);
  for (let i = 0; i < normalized.length; i += 1) {
    const charCode = normalized.charCodeAt(i);
    vector[i % dimension] += ((charCode % 31) + 1) * 0.1;
  }
  const magnitude = Math.hypot(...vector) || 1;
  return vector.map((value) => value / magnitude);
}

function buildStateUpdate({ existingState = {}, text, role }) {
  const trimmedText = String(text || '').trim();
  const isQuestion = trimmedText.includes('?');
  const nextState = { ...existingState };

  if (role === 'assistant') {
    nextState.lastAssistantMessage = trimmedText;
  } else {
    nextState.lastUserMessage = trimmedText;
    if (isQuestion) {
      nextState.lastQuestion = trimmedText;
      nextState.pendingQuestions = Array.from(new Set([...(existingState.pendingQuestions || []), trimmedText]));
    }
  }

  if (/\b(task|todo|next step|follow up|please remind|action item)\b/i.test(trimmedText)) {
    nextState.pendingTasks = Array.from(new Set([...(existingState.pendingTasks || []), trimmedText]));
  }

  if (/\b(about|regarding|on the topic of|topic is)\b/i.test(trimmedText)) {
    nextState.currentTopic = trimmedText;
  }

  nextState.updatedAt = new Date();
  return nextState;
}

async function persistPineconeVectors(doc, memoryText) {
  if (!env.enablePinecone || !pineconeService.isPineconeConfigured()) {
    console.warn('[PINECONE_SKIPPED] Pinecone disabled or not configured for userId=' + String(doc.userId));
    return;
  }
  if (!DEEP_MEMORY_CATEGORIES.includes(doc.category)) return;

  const vector = createTextEmbedding(memoryText);
  const metadata = {
    userId: String(doc.userId),
    category: doc.category,
    importanceScore: doc.importanceScore,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    contentPreview: memoryText.slice(0, 256),
  };

  try {
    await pineconeService.upsertLongTermVector({ id: String(doc._id), vector, metadata });
  } catch (error) {
    console.warn('Pinecone upsert failed for memory:', error);
  }
}

async function processUserMessage({ userId, sessionId, text, role = 'user' }) {
  const { userId: safeUserId, sessionId: safeSessionId } = memoryIsolationValidator.validateMemoryOperation({ userId, sessionId });

  // V6: Process with new memory intake (automatic categorization)
  const trace = [];
  trace.push(createTraceEvent('MESSAGE_RECEIVED', { userId: safeUserId, sessionId: safeSessionId, role, textPreview: String(text || '').slice(0, 120) }));

  const v6Intake = await memoryIntakeService.processIncomingMemory(
    safeUserId,
    safeSessionId,
    text,
    { sessionId: safeSessionId }
  ).catch((err) => {
    trace.push(createTraceEvent('V6_INTAKE_FAILED', { error: err?.message || String(err) }));
    return { success: false };
  });

  const extracted = memoryExtractor.extractAll(text || '');
  trace.push(createTraceEvent('MEMORY_EXTRACTED', { count: extracted.length, extracted }));

  const { accepted: acceptedMemories, rejected: rejectedMemories } = memoryFilterService.auditExtractedMemories(extracted, text);
  trace.push(createTraceEvent('MEMORY_FILTERED', {
    acceptedCount: acceptedMemories.length,
    rejectedCount: rejectedMemories.length,
    rejectedMemories,
  }));

  if (extracted.length > acceptedMemories.length) {
    await memoryMetricsService.incrementFilteredMemoryCount(safeUserId, extracted.length - acceptedMemories.length);
  }

  const scored = acceptedMemories.map((memory) => {
    const importanceScore = memoryImportanceService.calculateImportance({
      category: memory.category,
      memory: memory.memory,
      lastAccessed: null,
      accessCount: 0,
      userMessage: text,
    });
    return { ...memory, importanceScore };
  });

  const results = [];
  for (const memoryItem of scored) {
    trace.push(createTraceEvent('MEMORY_SAVE_ATTEMPT', { category: memoryItem.category, memoryPreview: String(memoryItem.memory || '').slice(0, 100), importanceScore: memoryItem.importanceScore }));
    // Fail fast on any save error
    const saved = await memoryStorageService.saveMemory({
      userId: safeUserId,
      category: memoryItem.category,
      memory: memoryItem.memory,
      tags: memoryItem.tags || [],
      importanceScore: memoryItem.importanceScore,
      source: 'direct',
    });

    if (!saved) throw new Error('Save returned empty result');
    if (saved && saved.success === false) throw new Error(`Save rejected: ${saved.reason || 'unknown'}`);

    // enqueue promotion/tracking job for this fingerprint (best-effort)
    try {
      await promotionQueueService.enqueuePromotion({
        userId: safeUserId,
        sessionId: safeSessionId,
        memoryFingerprint: saved.fingerprint,
        memoryCategory: saved.category,
        memoryId: String(saved._id || saved.id || ''),
      });
    } catch (e) {
      console.warn('Failed to enqueue promotion job:', e && e.message ? e.message : e);
    }

    await persistPineconeVectors(saved, memoryItem.memory);
    results.push({ memory: memoryItem, saved: { id: String(saved._id), category: saved.category } });
  }

  const existingState = await conversationStateService.getConversationState(safeUserId);
  const nextState = buildStateUpdate({ existingState, text, role });
  nextState.lastSessionId = safeSessionId || existingState?.lastSessionId || '';

  const finalState = await conversationStateService.updateConversationState(safeUserId, nextState);
  await sessionMemoryService.saveActiveSessionMemory(safeUserId, {
    currentTopic: finalState.currentTopic,
    currentTask: finalState.currentTask,
    emotion: finalState.emotion,
    lastQuestion: finalState.lastQuestion,
    lastUserMessage: finalState.lastUserMessage,
    lastAssistantMessage: finalState.lastAssistantMessage,
    pendingQuestions: finalState.pendingQuestions || [],
    pendingTasks: finalState.pendingTasks || [],
    sessionSummary: finalState.sessionSummary || '',
    lastSessionId: finalState.lastSessionId || '',
    updatedAt: finalState.updatedAt,
  });

  if (env.enableProfileCache) {
    memoryProfileService.rebuildMemoryProfile(safeUserId).catch((err) => {
      console.warn('Memory profile rebuild failed:', err);
    });
  }

  sessionBootstrapService.buildSessionBootstrapContext(safeUserId).catch((err) => {
    console.warn('Bootstrap cache refresh failed:', err);
  });

  if (env.enableUnfinishedContext) {
    unfinishedContextService.syncUnfinishedContexts(safeUserId, text, extracted).catch((err) => {
      console.warn('Unfinished context sync failed:', err);
    });
  }

  return {
    success: true,
    extracted: scored,
    results,
    conversationState: finalState,
  };
}

async function enqueueOrProcessMessage({ userId, sessionId, text, role = 'user' }) {
  const { userId: safeUserId, sessionId: safeSessionId } = memoryIsolationValidator.validateMemoryOperation({ userId, sessionId });

  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new Error('Text message is required for memory processing');
  }

  const existingState = await conversationStateService.getConversationState(safeUserId);
  const nextState = buildStateUpdate({ existingState, text, role });
  nextState.lastSessionId = safeSessionId || existingState?.lastSessionId || '';

  const finalState = await conversationStateService.updateConversationState(safeUserId, nextState);
  await sessionMemoryService.saveActiveSessionMemory(safeUserId, {
    currentTopic: finalState.currentTopic,
    currentTask: finalState.currentTask,
    emotion: finalState.emotion,
    lastQuestion: finalState.lastQuestion,
    lastUserMessage: finalState.lastUserMessage,
    lastAssistantMessage: finalState.lastAssistantMessage,
    pendingQuestions: finalState.pendingQuestions || [],
    pendingTasks: finalState.pendingTasks || [],
    sessionSummary: finalState.sessionSummary || '',
    lastSessionId: finalState.lastSessionId || '',
    updatedAt: finalState.updatedAt,
  });

  if (!env.enableQueue || env.certificationMode) {
    if (env.certificationMode) {
      console.warn('[CERTIFICATION_MODE] Bypassing memory queue and processing directly');
    }
    const result = await processUserMessage({ userId: safeUserId, sessionId: safeSessionId, text, role });
    return {
      ...result,
      queued: false,
      queueBypassed: true,
    };
  }

  const job = await memoryJobService.enqueueMemoryJob({ userId: safeUserId, message: text, priority: 'normal' });
  return { queued: true, jobId: String(job._id), conversationState: finalState };
}

async function getMemoryDiagnostics(userId) {
  const { userId: safeUserId } = memoryIsolationValidator.validateMemoryOperation({ userId });
  const redisClient = await sessionMemoryService.getActiveSessionMemory(safeUserId).catch(() => null);
  const profile = await memoryProfileService.getMemoryProfile(safeUserId).catch(() => null);
  const conversationState = await conversationStateService.getConversationState(safeUserId).catch(() => null);
  const bootstrap = await require('./bootstrapCacheService').getBootstrapContext(safeUserId).catch(() => null);
  const queueStatus = await memoryJobService.countQueueStatus().catch(() => null);
  const diagnostics = {
    mongoConnected: require('mongoose').connection.readyState === 1,
    redisConnected: Boolean(await redisService.getRedisClient().then(() => true).catch(() => false)),
    pineconeConnected: env.enablePinecone && pineconeService.isPineconeConfigured(),
    memoryProfilePresent: Boolean(profile),
    conversationState: conversationState || null,
    activeSessionMemory: redisClient || null,
    bootstrapStatus: bootstrap ? 'cached' : 'missing',
    queueStatus,
  };
  return diagnostics;
}

module.exports = { enqueueOrProcessMessage, processUserMessage, getMemoryDiagnostics };
