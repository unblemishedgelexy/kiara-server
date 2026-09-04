'use strict';

/**
 * Memory Retrieval Orchestrator
 * 
 * Implements intelligent, query-aware memory retrieval with escalation.
 * 
 * Pipeline:
 * 1. Query Analysis (intent, entities, keywords, temporal hints)
 * 2. Short-Term Search (recent Redis conversation)
 * 3. Check if answer found → return
 * 4. Long-Term Search (Pinecone vector search if not found)
 * 5. Check if answer found → return
 * 6. Deep Memory Search (if query indicates historical search)
 * 7. Rank all results by relevance
 * 8. Filter duplicates
 * 9. Apply anti-repetition (don't re-inject already surfaced)
 * 10. Compress to fit context budget
 * 11. Return final context
 * 
 * CRITICAL: Memory retrieval must NOT block Gemini Live.
 * Use timeouts and graceful degradation.
 */

const queryAnalyzer = require('./queryAnalyzer');
const deduplication = require('./deduplicationService');
const relevanceRanking = require('./relevanceRanking');
const contextBudget = require('./contextBudget');
const antiRepetition = require('./antiRepetitionTracker');
const logger = require('./memoryLogger');
const { log: traceLog } = require('./memoryTrace');
const { env } = require('../../../config/env');

function normalizeMemoryToken(value) {
  const token = String(value || '').toLowerCase();
  return token.replace(/s$/, '').replace(/colour/g, 'color');
}

function semanticMatchesQuery(item, analysis) {
  const profile = analysis.queryProfile || {};
  const category = normalizeMemoryToken(item.category);
  const attribute = category === 'identity'
    ? 'name'
    : normalizeMemoryToken(item.attribute || item.key);
  const label = normalizeMemoryToken(item.label);
  const valueTokens = String(item.value || '').toLowerCase().split(/[^a-z0-9\u0900-\u097f]+/i).filter(Boolean);
  const searchable = new Set([category, attribute, label, ...valueTokens].map(normalizeMemoryToken).filter(Boolean));

  const requestedCategory = normalizeMemoryToken(profile.category);
  const itemMatchesPreferenceItem = profile.attribute === 'favorite_item'
    && requestedCategory === 'preference'
    && category === 'fact';
  if (requestedCategory && category !== requestedCategory && !itemMatchesPreferenceItem) return false;
  if (profile.attribute) {
    const requested = normalizeMemoryToken(profile.attribute);
    if (requested === 'favorite_item') {
      if (attribute !== 'favorite_item' && !['book', 'food', 'drink', 'movie', 'song', 'music'].some((token) => searchable.has(token))) return false;
    } else if (requested === 'primary_goal' && category === 'goal') {
      // Goal records use the category as their logical attribute in storage.
    } else if (requested === 'skill' && category === 'skill') {
      // Skill records may use a generated attribute while retaining the skill category.
    } else if (attribute !== requested && !searchable.has(requested.replace('_', ' '))) {
      return false;
    }
  }

  if (profile.normalizedTokens?.length && !profile.category && !profile.attribute) {
    const overlap = profile.normalizedTokens.filter((token) => searchable.has(normalizeMemoryToken(token)));
    if (!overlap.length) return false;
  }
  return true;
}

// ────────────────────────────────────────────────────────────────────
// Timeouts
// ────────────────────────────────────────────────────────────────────

const MEMORY_RETRIEVAL_TIMEOUT_MS = 1500; // 1.5 seconds max for all memory ops
const SHORT_TERM_TIMEOUT_MS = 200;        // Very fast
const LONG_TERM_TIMEOUT_MS = 800;         // Medium
const DEEP_MEMORY_TIMEOUT_MS = 400;       // Fast fallback

// ────────────────────────────────────────────────────────────────────
// Escalation Search Strategy
// ────────────────────────────────────────────────────────────────────

/**
 * Search short-term memory (Redis).
 * Should be very fast.
 */
async function searchShortTermMemory(userId, sessionId, query, timeoutMs = SHORT_TERM_TIMEOUT_MS) {
  if (!userId || !sessionId) return [];
  
  const startAt = Date.now();
  
  try {
    const promise = async () => {
      // Import at runtime to avoid circular deps
      const WorkingMemoryRedis = require('../../workingMemory/redisOperations');
      const turns = await WorkingMemoryRedis.getRecentMemory(userId);
      
      if (!Array.isArray(turns) || turns.length === 0) {
        return [];
      }
      
      // Filter by relevance if query provided
      if (query && query.keywords && query.keywords.length > 0) {
        return turns.filter(turn => {
          const text = `${turn.userMessage || ''} ${turn.assistantResponse || turn.aiResponse || ''}`.toLowerCase();
          return query.keywords.some(kw => text.includes(String(kw).toLowerCase()));
        });
      }
      
      return turns;
    };
    
    const result = await Promise.race([
      promise(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('STM_TIMEOUT')), timeoutMs)),
    ]);
    
    const durationMs = Date.now() - startAt;
    logger.log('STM_SEARCH', { userId, found: Array.isArray(result) ? result.length : 0, durationMs });
    
    return Array.isArray(result) ? result : [];
  } catch (err) {
    if (err.message === 'STM_TIMEOUT') {
      logger.log('STM_SEARCH_TIMEOUT', { userId, timeoutMs });
    } else {
      logger.logError('STM_SEARCH_ERROR', err, { userId });
    }
    return [];
  }
}

/**
 * Search long-term memory (Pinecone).
 * May need multiple queries.
 */
async function searchLongTermMemory(userId, query, timeoutMs = LONG_TERM_TIMEOUT_MS) {
  if (!userId || !query || !String(query).trim()) return [];
  
  const startAt = Date.now();
  
  try {
    const promise = async () => {
      // Import at runtime
      const retriever = require('../retrieval/retriever');
      const result = await retriever.retrieve({
        userId,
        query: String(query).slice(0, 200), // Limit query length
        topK: 6,
      });
      
      return Array.isArray(result.results) ? result.results : [];
    };
    
    const result = await Promise.race([
      promise(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('LTM_TIMEOUT')), timeoutMs)),
    ]);
    
    const durationMs = Date.now() - startAt;
    logger.log('LTM_SEARCH', { userId, found: Array.isArray(result) ? result.length : 0, durationMs });
    
    return Array.isArray(result) ? result : [];
  } catch (err) {
    if (err.message === 'LTM_TIMEOUT') {
      logger.log('LTM_SEARCH_TIMEOUT', { userId, timeoutMs });
    } else {
      logger.logError('LTM_SEARCH_ERROR', err, { userId });
    }
    return [];
  }
}

/**
 * Search deep memory (archive, historical).
 * For now, returns empty (future: could be MongoDB aggregation).
 */
async function searchDeepMemory(userId, query, timeoutMs = DEEP_MEMORY_TIMEOUT_MS) {
  // TODO: Implement deep memory search when needed
  // For now, returns empty to avoid unnecessary delays
  return [];
}

/**
 * Orchestrate intelligent retrieval with escalation.
 */
async function retrieveMemoryForQuery(query, sessionContext = {}) {
  const startAt = Date.now();
  const userId = sessionContext.userId || 'anonymous';
  const sessionId = sessionContext.sessionId || userId;
  const activeContext = sessionContext.activeContext || {};
  const currentQuestion = String(query || '').trim();
  const memoryTraceId = sessionContext.memoryTraceId || null;

  logger.log('MEMORY_QUERY', {
    userId,
    sessionId,
    query: currentQuestion.slice(0, 120),
    activeEntities: Array.isArray(activeContext.activeEntities) ? activeContext.activeEntities : [],
    lastReferencedEntity: activeContext.lastReferencedEntity || null,
  });

  const analysis = queryAnalyzer.analyzeQuery(query, sessionContext);
  traceLog('query_analysis_result', { memoryTraceId, userId, sessionId, operation: 'memory_retrieval', detectedIntent: analysis.intent, category: analysis.queryProfile?.category || null, logicalKey: analysis.queryProfile?.attribute ? `${analysis.queryProfile.category || 'memory'}:${analysis.queryProfile.attribute}` : null, ambiguity: Boolean(analysis.ambiguous), fallbackMode: analysis.shouldSearchLongTerm ? 'long_term_if_needed' : 'structured_only' });
  const fallbackReason = 'No reliable memory found';

  let memories = [];
  let shortTermResult = [];
  let longTermResult = [];
  let semanticResult = [];

  const isEmptyQuery = !currentQuestion;
  const canonicalIntent = new Set([
    'identity_recall',
    'preference_query',
    'relationship_query',
    'goal_query',
    'skill_query',
    'fact_query',
    'project_query',
  ]);
  const resolvesCanonicalMemory = canonicalIntent.has(analysis.intent);

  if (!isEmptyQuery && analysis.shouldSearchShortTerm && !resolvesCanonicalMemory) {
    shortTermResult = await searchShortTermMemory(userId, sessionId, analysis, 120);
    memories.push(...shortTermResult);
    logger.log('MEMORY_SHORT_TERM', {
      userId,
      sessionId,
      matched: shortTermResult.length,
      query: currentQuestion.slice(0, 120),
      candidates: shortTermResult.slice(0, 5).map((m) => m.id || m.memoryId || m.userMessage || m.summary || '').filter(Boolean),
    });
  }

  try {
    const WorkingMemoryRedis = require('../../workingMemory/redisOperations');
    const semanticRevisionBefore = await WorkingMemoryRedis.getSemanticMemoryRevision(userId);
    let semantic = await WorkingMemoryRedis.getSemanticMemories(userId);
    const semanticRevisionAfter = await WorkingMemoryRedis.getSemanticMemoryRevision(userId);
    if (semanticRevisionBefore !== semanticRevisionAfter) {
      traceLog('memory_revision_changed_during_retrieval', { memoryTraceId, userId, before: semanticRevisionBefore, after: semanticRevisionAfter, decision: 'reread_current_canonical_memory' });
      semantic = await WorkingMemoryRedis.getSemanticMemories(userId);
    }
      const semanticItems = Object.values(semantic || {}).flat().filter(Boolean);
    if (semanticItems.length) {
      const matchingSemantic = isEmptyQuery
        ? semanticItems
        : semanticItems.filter((item) => semanticMatchesQuery(item, analysis));
      traceLog('redis_semantic_lookup', { memoryTraceId, userId, operation: 'semantic_lookup', queriedCategory: analysis.queryProfile?.category || null, queriedLogicalKey: analysis.queryProfile?.attribute || null, candidateCount: semanticItems.length, activeCandidateCount: matchingSemantic.length, excludedCount: semanticItems.length - matchingSemantic.length, retrievalDecision: isEmptyQuery ? 'canonical_active_only' : 'query_filtered', memorySource: 'redis_semantic', statuses: ['active'], canonicalMemorySelected: matchingSemantic.slice(0, 10).map((item) => ({ logicalKey: item.logicalKey || `${item.category}:${item.attribute || item.key || item.category}`, source: item.source || 'unknown', status: item.status || 'active' })) });
      if (matchingSemantic.length) {
        semanticResult = matchingSemantic.map((item) => ({
          id: item.id || `${item.category}:${item.key}:${item.value}`,
          type: item.category === 'identity' ? 'identity' : item.category,
          category: item.category,
          value: item.value,
          summary: item.value,
          metadata: { summary: item.value, value: item.value, category: item.category, confidence: item.confidenceScore || item.confidence || 0.8 },
          confidence: Number(item.confidenceScore || item.confidence || 0.8),
          importance: Number(item.importance || 0.8),
          logicalKey: item.logicalKey || `${item.category}:${item.attribute || item.key || item.category}`,
        }));
        memories.push(...semanticResult);
      }
    }
  } catch (err) {
    logger.logError('MEMORY_SEMANTIC_RETRIEVAL_ERROR', err, { userId, sessionId });
  }

  if (analysis.shouldSearchLongTerm && memories.length === 0 && !resolvesCanonicalMemory) {
    traceLog('pinecone_fallback', { memoryTraceId, userId, operation: 'pinecone_lookup', triggered: true, reason: 'no_structured_memory_match', namespace: userId, structuredMemoryAlreadyExisted: semanticResult.length > 0 });
    longTermResult = await searchLongTermMemory(userId, query, 300);
    memories.push(...longTermResult);
    logger.log('MEMORY_LONG_TERM', {
      userId,
      sessionId,
      matched: longTermResult.length,
      query: currentQuestion.slice(0, 120),
      candidates: longTermResult.slice(0, 5).map((m) => m.id || m.memoryId || m.metadata?.summary || '').filter(Boolean),
    });
  }

  if (analysis.shouldSearchDeep && memories.length === 0) {
    semanticResult = await searchDeepMemory(userId, query, 250);
    memories.push(...semanticResult);
    logger.log('MEMORY_SEMANTIC', {
      userId,
      sessionId,
      matched: semanticResult.length,
      query: currentQuestion.slice(0, 120),
    });
  }

  const deduped = isEmptyQuery
    ? semanticResult
    : deduplication.deduplicateMemoryList(memories);
  const ranked = isEmptyQuery
    ? deduped
    : relevanceRanking.rankMemories(deduped, {
    intent: analysis.intent,
    entities: analysis.entities,
    keywords: analysis.keywords,
    temporalHint: analysis.temporalHint,
    embedding: null,
    });

  const filtered = isEmptyQuery
    ? semanticResult.slice(0, 10)
    : resolvesCanonicalMemory
      ? ranked.slice(0, 10)
      : antiRepetition.filterOutSurfacedMemories(ranked, userId, sessionId).slice(0, 10);
  const selected = filtered.slice(0, 5);
  const excluded = ranked.slice(0, 10).filter((item) => !selected.some((selectedItem) => (selectedItem.id || selectedItem.memoryId) === (item.id || item.memoryId))).slice(0, 5);

  logger.log('MEMORY_SELECTED', {
    userId,
    sessionId,
    selected: selected.map((m) => ({ id: m.id || m.memoryId, score: m.relevanceScore || m.score || 0 })),
  });
  traceLog('active_candidate_selection', { memoryTraceId, userId, sessionId, operation: 'memory_retrieval', candidatesConsidered: ranked.length, selectedMemoryId: selected[0]?.id || selected[0]?.memoryId || null, selectedLogicalKey: selected[0]?.logicalKey || selected[0]?.key || null, selectionReason: selected.length ? 'ranked_active_candidate' : 'no_candidate', selectedCount: selected.length });
  traceLog('context_exclusions', { memoryTraceId, userId, sessionId, operation: 'memory_retrieval', excludedCount: excluded.length, reasons: ['superseded_or_rejected_or_low_relevance_or_already_surfaced'] });
  logger.log('MEMORY_EXCLUDED', {
    userId,
    sessionId,
    excluded: excluded.map((m) => ({ id: m.id || m.memoryId, score: m.relevanceScore || m.score || 0, reason: 'low_relevance_or_already_surfaced' })),
  });

  function formatMemoryText(memory) {
    const category = String(memory.category || memory.type || '').toLowerCase();
    const label = memory.label || memory.key || memory.title || (category === 'identity' ? 'Name' : '');
    const value = memory.value || memory.content || memory.summary || memory.userMessage || memory.aiResponse || memory.metadata?.summary || memory.metadata?.value || '';
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue) return '';

    if (category === 'identity') {
      const cleanedValue = String(normalizedValue).replace(/^\s*['\"\(\[]|['\"\)\]]\s*$/g, '').trim();
      return `${label || 'Name'}: ${cleanedValue}`;
    }

    return String(normalizedValue).trim();
  }

  const compressedContext = selected
    .map((memory) => formatMemoryText(memory))
    .filter(Boolean)
    .join('\n');

  const contextPacket = {
    currentQuestion,
    relevantShortTermContext: shortTermResult.slice(0, 5).map((m) => ({
      id: m.id || m.memoryId,
      text: m.summary || m.content || m.userMessage || m.aiResponse || m.metadata?.summary || '',
      source: 'short_term',
    })),
    relevantLongTermMemory: longTermResult.slice(0, 5).map((m) => ({
      id: m.id || m.memoryId,
      text: m.summary || m.metadata?.summary || m.content || '',
      source: 'long_term',
    })),
    relevantSemanticMemory: semanticResult.slice(0, 5).map((m) => ({
      id: m.id || m.memoryId,
      text: m.summary || m.metadata?.summary || m.content || '',
      source: 'semantic',
    })),
    entities: analysis.entities,
    relationships: Array.isArray(activeContext.activeEntities) ? activeContext.activeEntities : [],
    exclusions: excluded.map((m) => ({ id: m.id || m.memoryId, reason: 'low_relevance_or_already_surfaced' })),
  };

  let source = 'NONE';
  let confidence = 0;
  let unresolved = true;
  let reason = fallbackReason;

  if (selected.length > 0) {
    const topScore = Number(selected[0].relevanceScore || selected[0].score || 0);
    source = selected[0].userMessage || selected[0].assistantResponse ? 'STM' : selected[0].namespace === 'projects' || selected[0].namespace === 'semantic' ? 'LTM' : 'LTM';
    confidence = Math.min(1, Math.max(0, topScore));
    unresolved = false;
    reason = topScore > 0.5 ? 'Relevant memory identified' : 'Low-confidence memory selected';
  }

  logger.log('MEMORY_CONTEXT_PACKET', {
    userId,
    sessionId,
    source,
    confidence,
    selectedCount: selected.length,
    contextLength: compressedContext.length,
    packet: {
      currentQuestion: currentQuestion.slice(0, 180),
      entities: analysis.entities,
      selectedCount: selected.length,
    },
  });

  logger.log('MEMORY_CONTEXT_BUILT', {
    userId,
    sessionId,
    source,
    confidence,
    memories: selected.length,
    latencyMs: Date.now() - startAt,
    intent: analysis.intent,
  });

  return {
    query: currentQuestion,
    intent: analysis.intent,
    entities: analysis.entities,
    source,
    confidence,
    memories: selected,
    compressedContext,
    contextPacket,
    unresolved,
    reason,
    latencyMs: Date.now() - startAt,
    memoryRevision: await require('../../workingMemory/redisOperations').getSemanticMemoryRevision(userId),
  };
}

async function retrieveMemoryWithEscalation(userId, sessionId, userQuery, options = {}) {
  const startAt = Date.now();
  const isLiveContext = options.isLiveContext !== false;
  const activeContext = options.activeContext || {};
  const memoryTraceId = options.memoryTraceId || null;
  const WorkingMemoryRedis = require('../../workingMemory/redisOperations');
  const memoryRevision = await WorkingMemoryRedis.getSemanticMemoryRevision(userId);

  logger.log('MEMORY_RETRIEVAL_START', {
    userId,
    sessionId,
    userQuery: String(userQuery || '').slice(0, 100),
    isLive: isLiveContext,
    activeEntities: Array.isArray(activeContext.activeEntities) ? activeContext.activeEntities : [],
    lastReferencedEntity: activeContext.lastReferencedEntity || null,
    memoryRevision,
  });

  antiRepetition.initializeSession(userId, sessionId);

  const queryAnalysis = queryAnalyzer.analyzeQuery(userQuery, { activeContext });
  logger.log('QUERY_ANALYZED', {
    intent: queryAnalysis.intent,
    entities: queryAnalysis.entities.length,
    keywords: queryAnalysis.keywords.length,
    shouldSearchSTM: queryAnalysis.shouldSearchShortTerm,
    shouldSearchLTM: queryAnalysis.shouldSearchLongTerm,
    shouldSearchDeep: queryAnalysis.shouldSearchDeep,
    activeContext: Array.isArray(activeContext.activeEntities) ? activeContext.activeEntities : [],
  });

  const queryResult = await retrieveMemoryForQuery(userQuery, {
    userId,
    sessionId,
    activeContext,
    memoryTraceId,
  });

  const allMemories = Array.isArray(queryResult.memories) ? queryResult.memories : [];
  const filtered = allMemories;
  const contextData = {
    identity: filtered.filter(m => (m.type || m.category) === 'identity').slice(0, 3),
    activeProject: filtered.find(m => (m.type || m.category) === 'project' && m.active),
    relationships: filtered.filter(m => (m.type || m.category) === 'person').slice(0, 5),
    episodes: filtered.filter(m => (m.type || m.category) === 'episode').slice(0, 8),
    preferences: filtered.filter(m => (m.type || m.category) === 'preference').slice(0, 2),
    recentTurns: filtered.filter(m => m.userMessage).slice(0, 10),
  };

  const budgetedContext = contextBudget.buildBudgetedContext(contextData, {
    TOTAL_CONTEXT_TOKENS: env.memoryContextBudgetTokens || 1500,
  });

  const durationMs = Date.now() - startAt;
  logger.log('RETRIEVAL_COMPLETE', {
    userId,
    durationMs,
    finalContextTokens: budgetedContext.totalTokens,
    budgetUsagePercent: budgetedContext.budgetUsagePercent,
    isLiveContext,
    selectedCount: filtered.length,
  });

  if (isLiveContext && durationMs > 500) {
    logger.log('LIVE_RETRIEVAL_SLOW', {
      userId,
      durationMs,
      warning: 'Memory retrieval took longer than ideal for Live session',
    });
  }

  const finalMemoryRevision = await WorkingMemoryRedis.getSemanticMemoryRevision(userId);
  if (finalMemoryRevision !== memoryRevision) {
    traceLog('memory_revision_changed_during_retrieval', {
      memoryTraceId,
      userId,
      sessionId,
      before: memoryRevision,
      after: finalMemoryRevision,
      decision: 'retrieval_result_must_be_refreshed_by_caller',
    });
  }

  return {
    context: queryResult.compressedContext || budgetedContext.context || '',
    totalTokens: Math.max(budgetedContext.totalTokens || 0, String(queryResult.compressedContext || '').length / 4),
    budgetUsagePercent: budgetedContext.budgetUsagePercent || 0,
    retrievedMemoriesCount: filtered.length,
    durationMs,
    queryAnalysis,
    allMemories: filtered,
    contextPacket: queryResult.contextPacket || {
      currentQuestion: String(userQuery || '').trim(),
      relevantShortTermContext: [],
      relevantLongTermMemory: [],
      relevantSemanticMemory: [],
      entities: queryAnalysis.entities,
      relationships: Array.isArray(activeContext.activeEntities) ? activeContext.activeEntities : [],
      exclusions: [],
    },
    memoryRevision: finalMemoryRevision,
    contextMemoryRevision: finalMemoryRevision,
  };
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

module.exports = {
  // Main entry point
  retrieveMemoryWithEscalation,
  retrieveMemoryForQuery,
  
  // Lower-level searches (for testing)
  searchShortTermMemory,
  searchLongTermMemory,
  searchDeepMemory,
  
  // Constants
  MEMORY_RETRIEVAL_TIMEOUT_MS,
};
