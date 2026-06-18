const { env } = require('../config/env');
const memoryExtractor = require('./memoryExtractorService');
const memoryImportanceService = require('./memoryImportanceService');
const memoryStorageService = require('./memoryStorageService');
const conversationStateService = require('./conversationStateService');
const sessionMemoryService = require('./sessionMemoryService');
const memoryProfileService = require('./memoryProfileService');
const sessionBootstrapService = require('./sessionBootstrapService');
const pineconeService = require('./pineconeService');
const memoryJobService = require('./memoryJobService');
const unfinishedContextService = require('./unfinishedContextService');

const DEEP_MEMORY_CATEGORIES = ['identity', 'project', 'goal', 'relationship', 'fact'];

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
  if (!env.enablePinecone || !pineconeService.isPineconeConfigured()) return;
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
  const extracted = memoryExtractor.extractAll(text || '');

  const scored = extracted.map((memory) => {
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
    try {
      const saved = await memoryStorageService.saveMemory({
        userId,
        category: memoryItem.category,
        memory: memoryItem.memory,
        tags: memoryItem.tags || [],
        importanceScore: memoryItem.importanceScore,
        source: 'direct',
      });
      await persistPineconeVectors(saved, memoryItem.memory);
      results.push({ memory: memoryItem, saved: { id: String(saved._id), category: saved.category } });
    } catch (error) {
      results.push({ memory: memoryItem, error: error.message });
    }
  }

  const existingState = await conversationStateService.getConversationState(userId);
  const nextState = buildStateUpdate({ existingState, text, role });
  nextState.lastSessionId = sessionId || existingState?.lastSessionId || '';

  const finalState = await conversationStateService.updateConversationState(userId, nextState);
  await sessionMemoryService.saveActiveSessionMemory(userId, {
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
    memoryProfileService.rebuildMemoryProfile(userId).catch((err) => {
      console.warn('Memory profile rebuild failed:', err);
    });
  }

  sessionBootstrapService.buildSessionBootstrapContext(userId).catch((err) => {
    console.warn('Bootstrap cache refresh failed:', err);
  });

  if (env.enableUnfinishedContext) {
    unfinishedContextService.syncUnfinishedContexts(userId, text, extracted).catch((err) => {
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
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new Error('Text message is required for memory processing');
  }

  const existingState = await conversationStateService.getConversationState(userId);
  const nextState = buildStateUpdate({ existingState, text, role });
  nextState.lastSessionId = sessionId || existingState?.lastSessionId || '';

  const finalState = await conversationStateService.updateConversationState(userId, nextState);
  await sessionMemoryService.saveActiveSessionMemory(userId, {
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

  if (!env.enableQueue) {
    return processUserMessage({ userId, sessionId, text, role });
  }

  const job = await memoryJobService.enqueueMemoryJob({ userId, message: text, priority: 'normal' });
  return { queued: true, jobId: String(job._id), conversationState: finalState };
}

async function getMemoryDiagnostics(userId) {
  const redisClient = await sessionMemoryService.getActiveSessionMemory(userId).catch(() => null);
  const profile = await memoryProfileService.getMemoryProfile(userId).catch(() => null);
  const conversationState = await conversationStateService.getConversationState(userId).catch(() => null);
  const bootstrap = await require('./bootstrapCacheService').getBootstrapContext(userId).catch(() => null);
  const queueStatus = await memoryJobService.countQueueStatus().catch(() => null);
  const diagnostics = {
    mongoConnected: require('mongoose').connection.readyState === 1,
    redisConnected: Boolean(await require('./redisService').getRedisClient().then(() => true).catch(() => false)),
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
