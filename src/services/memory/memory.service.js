'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║              KIARA AI — Memory Intelligence Service              ║
 * ║                  The ONLY public entry point                     ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * All other modules under services/memory/ are PRIVATE.
 * The active pipeline stores only completed short-term conversation turns.
 *
 * External callers use ONLY:
 *   MemoryService.saveTurn()
 *   MemoryService.prepareContext()
 *   MemoryService.prepareContext()
 *
 * ──────────────────────────────────────────────────────────────────
 * SAVE PIPELINE
 * ──────────────────────────────────────────────────────────────────
 *  saveTurn()
 *    → WorkingMemoryRedis.saveConversationTurn()    ← returns to caller
 *    → no extraction or long-term-memory side effects
 *
 * ──────────────────────────────────────────────────────────────────
 * RETRIEVAL PIPELINE  (called at session start / new prompt)
 * ──────────────────────────────────────────────────────────────────
 *  prepareContext()
 *    → WorkingMemoryRedis.getRecentMemory()
 *    → promptBuilder.buildContext()
 *    → returns { systemPrompt, facts, task, turnCount }
 */

const WorkingMemoryRedis = require('../workingMemory/redisOperations');
const { InvalidUserError, MissingSessionError, EmptyMessageError } = require('../../utils/workingMemory/errors');
const { env } = require('../../config/env');

// ── Private sub-modules ─────────────────────────────────────────────
const promptBuilder   = require('./retrieval/promptBuilder');
const logger          = require('./utils/memoryLogger');
const { prepareLongTermMemory } = require('./longTermHandoff');
const pineconeService = require('../pineconeService');
const { log: traceLog, createMemoryTraceId } = require('./utils/memoryTrace');
const { computeEmbedding } = require('../../utils/memory/memoryUtils');
const retriever = require('./retrieval/retriever');
const strictRetriever = require('./retrieval/strictRetriever');
const memoryOrchestrator = require('./utils/memoryRetrievelOrchestrator');
const antiRepetition = require('./utils/antiRepetitionTracker');
const { isMemoryEligible } = require('./memoryStabilityGate');

// ── Config ─────────────────────────────────────────────────────────
const DEFAULT_TTL           = env.shortTermMemoryTTL;          // 25 minutes for conversation turns
// Retrieval is now driven by a time window rather than a fixed turn count.
const SNAPSHOT_INTERVAL_MS  = 15 * 60 * 1000; // 15 minutes
const IDLE_TIMEOUT_MS       = 22 * 60 * 1000; // 22 minutes

const stmSessionStates = new Map();

function _makeSessionKey(userId, sessionId) {
  return `${userId}:${sessionId}`;
}

function _clearHandoffTimers(sessionKey) {
  const state = stmSessionStates.get(sessionKey);
  if (!state) return;
  if (state.snapshotTimer) {
    clearTimeout(state.snapshotTimer);
  }
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
  }
  stmSessionStates.delete(sessionKey);
}

function _scheduleSnapshot(sessionKey) {
  const state = stmSessionStates.get(sessionKey);
  if (!state) return;
  if (state.snapshotTimer) {
    clearTimeout(state.snapshotTimer);
  }
  state.snapshotTimer = setTimeout(async () => {
    try {
      await _handleSnapshotTimer(sessionKey);
    } catch (err) {
      logger.error('STM_SNAPSHOT_TIMER_ERROR', err, { sessionKey });
    }
  }, SNAPSHOT_INTERVAL_MS);
}

function _resetIdleTimer(sessionKey) {
  const state = stmSessionStates.get(sessionKey);
  if (!state) return;
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
  }
  state.idleTimer = setTimeout(async () => {
    try {
      await _handleIdleTimer(sessionKey);
    } catch (err) {
      logger.error('STM_IDLE_TIMER_ERROR', err, { sessionKey });
    }
  }, IDLE_TIMEOUT_MS);
}

function _startSessionState(userId, sessionId) {
  const sessionKey = _makeSessionKey(userId, sessionId);
  _clearHandoffTimers(sessionKey);

  const state = {
    userId,
    sessionId,
    startedAt: new Date().toISOString(),
    lastActivityAt: Date.now(),
    snapshotTimer: null,
    idleTimer: null,
  };

  stmSessionStates.set(sessionKey, state);
  logger.logConversationStarted(userId, sessionId);
  _scheduleSnapshot(sessionKey);
  _resetIdleTimer(sessionKey);
}

function _refreshSessionState(userId, sessionId) {
  const sessionKey = _makeSessionKey(userId, sessionId);
  const state = stmSessionStates.get(sessionKey);
  if (!state) {
    _startSessionState(userId, sessionId);
    return;
  }
  state.lastActivityAt = Date.now();
  _resetIdleTimer(sessionKey);
}

function _buildStmSnapshot(sessionId, turns) {
  const conversationId = sessionId;
  const conversationStartTime = turns.length ? turns[0].timestamp : new Date().toISOString();
  const conversationEndTime = turns.length ? turns[turns.length - 1].timestamp : conversationStartTime;
  const userMessages = turns.map((turn) => turn.userMessage);
  const assistantMessages = turns.map((turn) => turn.assistantResponse || turn.aiResponse || turn.assistantMessage || '');
  const timestamps = turns.map((turn) => turn.timestamp);
  const characterCount = turns.reduce((total, turn) => {
    const userLen = String(turn.userMessage || '').length;
    const assistantLen = String(turn.assistantResponse || turn.aiResponse || turn.assistantMessage || '').length;
    return total + userLen + assistantLen;
  }, 0);
  const estimatedTokens = Math.ceil(characterCount / 4);

  return {
    sessionId,
    conversationId,
    conversationStartTime,
    conversationEndTime,
    turnCount: turns.length,
    userMessages,
    assistantMessages,
    timestamps,
    characterCount,
    estimatedTokens,
    rawConversation: turns,
  };
}

/**
 * Stage: Working Memory Retrieval
 * Returns array of complete turns (oldest -> newest)
 */
async function _retrieveWorkingMemory(userId) {
  const turns = await WorkingMemoryRedis.getRecentMemory(userId);
  if (!Array.isArray(turns) || turns.length === 0) {
    return [];
  }

  return turns;
}

/**
 * Stage: Identity Retrieval (placeholder)
 */
async function _retrieveIdentity(userId) {
  // Placeholder for identity lookup (return null for now)
  return null;
}

/**
 * Stage: Current Goal Retrieval (placeholder)
 */
async function _retrieveCurrentGoal(userId) {
  // Placeholder for current goal retrieval
  return null;
}

/**
 * Stage: Current Project Retrieval (placeholder)
 */
async function _retrieveCurrentProject(userId) {
  // Placeholder for current project retrieval
  return null;
}

/**
 * Stage: Long Term Retrieval (placeholder, returns empty)
 */
async function _retrieveLongTerm(userId, userQuery) {
  if (!env.enablePinecone || !userQuery || !String(userQuery).trim()) {
    logger.longTermRetrieval({ userId, userQuery: String(userQuery || '').slice(0, 80), status: 'skipped', reason: 'disabled_or_empty_query' });
    return [];
  }

  try {
    // Delegate to retriever wrapper which handles analysis, namespace selection,
    // multi-namespace querying, scoring, and deduplication.
    const res = await retriever.retrieve({ userId, query: userQuery, topK: 6 });
    const results = Array.isArray(res.results) ? res.results : [];
    logger.longTermRetrieval({ userId, userQuery: String(userQuery).slice(0, 80), status: 'completed', resultCount: results.length });
    return results;
  } catch (err) {
    logger.longTermRetrieval({ userId, userQuery: String(userQuery).slice(0, 80), status: 'error', error: err.message || String(err) });
    logger.logError('LONG_TERM_RETRIEVAL_ERROR', err, { userId, userQuery, stage: 'memory-service' });
    return [];
  }
}

/**
 * Stage: Context Assembly - orchestrates formatting by promptBuilder
 */
async function _assembleContext(userId, { identity, goal, project, workingTurns, longTerm, userQuery = null }) {
  // Gather semantic memories and relationships to compose a coherent context.
  const recentTurns = Array.isArray(workingTurns) ? workingTurns : [];
  const semantic = await WorkingMemoryRedis.getSemanticMemories(userId);
  const relationships = await WorkingMemoryRedis.getRelationships(userId);

  // Identify identity, preferences, goals, projects from semantic memories
  const identityFacts = (semantic.identity && semantic.identity.length) ? semantic.identity : [];
  const preferenceFacts = (semantic.preferences && semantic.preferences.length) ? semantic.preferences : [];
  const goalFacts = (semantic.goals && semantic.goals.length) ? semantic.goals : [];
  const projectFacts = (semantic.projects && semantic.projects.length) ? semantic.projects : [];

  // Prepare episodes: longTerm may be an array of scored results (from retriever)
  const episodes = Array.isArray(longTerm) ? longTerm.map((r) => ({ id: r.id, metadata: r.metadata || r.raw?.metadata || {}, score: r.finalScore || r.raw?.score || 0 })) : [];

  // Temporal buckets helper
  const now = Date.now();
  function bucketForTimestamp(ts) {
    if (!ts) return 'older';
    const t = Number(new Date(String(ts)).getTime());
    if (Number.isNaN(t)) return 'older';
    const delta = now - t;
    const day = 24 * 60 * 60 * 1000;
    if (delta < day) return 'today';
    if (delta < 2 * day) return 'yesterday';
    if (delta < 7 * day) return 'last_week';
    if (delta < 30 * day) return 'last_month';
    return 'older';
  }

  // Attach temporal bucket to episodes
  for (const ep of episodes) {
    const ts = ep.metadata?.timelineEnd || ep.metadata?.updatedAt || ep.metadata?.createdAt || null;
    ep.temporalBucket = bucketForTimestamp(ts);
  }

  // Current active project priority: prefer semantic project flagged active, otherwise highest importance
  let activeProject = null;
  if (projectFacts && projectFacts.length) {
    activeProject = projectFacts.find((p) => p.active) || projectFacts.sort((a, b) => (Number(b.importance || 0) - Number(a.importance || 0)))[0];
  }

  // Build final structured context via promptBuilder
  const systemPrompt = promptBuilder.buildContext({
    userId,
    identity: identityFacts,
    relationships,
    goal: goalFacts && goalFacts.length ? goalFacts[0] : goal || null,
    activeProject,
    preferences: preferenceFacts,
    facts: semantic,
    episodes,
    recentTurns,
    userQuery,
  });

  return { systemPrompt, facts: semantic, task: goal || null, turnCount: recentTurns.length };
}

async function _dispatchSnapshot(userId, sessionId) {
  const turns = await WorkingMemoryRedis.getRecentMemory(userId);
  if (!turns || turns.length === 0) {
    return null;
  }
  const snapshot = _buildStmSnapshot(sessionId, turns);
  prepareLongTermMemory(snapshot);
  logger.logSnapshotPrepared(userId, sessionId, snapshot.turnCount, snapshot.characterCount);
  return snapshot;
}

async function _handleSnapshotTimer(sessionKey) {
  const state = stmSessionStates.get(sessionKey);
  if (!state) return;
  const idleAgo = Date.now() - state.lastActivityAt;
  if (idleAgo >= IDLE_TIMEOUT_MS) {
    return;
  }
  await _dispatchSnapshot(state.userId, state.sessionId);
  _scheduleSnapshot(sessionKey);
}

async function _handleIdleTimer(sessionKey) {
  const state = stmSessionStates.get(sessionKey);
  if (!state) return;
  await _dispatchSnapshot(state.userId, state.sessionId);
  _clearHandoffTimers(sessionKey);
}

// ───────────────────────────────────────────────────────────────────
// PRIVATE: input validation
// ───────────────────────────────────────────────────────────────────
function _validateTurnInputs(userId, sessionId, userMessage, aiResponse) {
  if (!userId   || typeof userId    !== 'string') throw new InvalidUserError(userId);
  if (!sessionId|| typeof sessionId !== 'string') throw new MissingSessionError(sessionId);
  if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) throw new EmptyMessageError('user');
  if (!aiResponse  || typeof aiResponse  !== 'string' || !aiResponse.trim())  throw new EmptyMessageError('assistant');
}

// ───────────────────────────────────────────────────────────────────
// PRIVATE: fire-and-forget background extraction job
// Runs after the conversation turn is already saved to Redis.
// Never throws — errors are logged internally.
// ───────────────────────────────────────────────────────────────────
function _runBackgroundExtraction(userId, sessionId, userMessage, aiResponse, turnId) {
  // Disabled for Phase 1. Persistence is intentionally raw and deterministic.
  return undefined;
}

// Legacy compatibility helpers live below. Core prompt assembly uses
// _retrieveWorkingMemory() and does not impose any hidden character budget.

// ───────────────────────────────────────────────────────────────────
// PUBLIC API
// ───────────────────────────────────────────────────────────────────

const MemoryService = {

  /**
   * Save a complete conversation turn to working memory.
   * Immediately returns after Redis write.
   * Fact extraction happens asynchronously in the background.
   *
   * @param {Object} opts
   * @param {string} opts.userId
   * @param {string} opts.sessionId
   * @param {string} opts.userMessage   — complete, not streaming
   * @param {string} opts.aiResponse    — complete, not streaming
   * @param {number} [opts.ttl]         — seconds, default 3600
   * @returns {Promise<{success:boolean, memorySaved:boolean, turnId:string|null, totalTurns:number, ttl:number}>}
   */
  async saveTurn({ userId, sessionId, userMessage, aiResponse, ttl = DEFAULT_TTL, memoryTraceId = createMemoryTraceId() }) {
    if (!userId || !sessionId) {
      return { success: false, memorySaved: false, turnId: null, totalTurns: 0, ttl, timestamp: new Date().toISOString(), skipped: true, reason: 'missing_user_or_session' };
    }

    if (!isMemoryEligible(userId, sessionId)) {
      return { success: false, memorySaved: false, turnId: null, totalTurns: 0, ttl, timestamp: new Date().toISOString(), skipped: true, reason: 'memory_gate_closed' };
    }

    let saveStartedAt = Date.now();
    try {
      const normalizedText = String(userMessage || '').replace(/\s+/g, ' ').trim();
      traceLog('normalized_input', { memoryTraceId, originalText: String(userMessage || ''), normalizedText });
      traceLog('working_memory_before', { memoryTraceId, userId, sessionId, existingTurnCount: 0, recentTurns: [] });
      console.info('[ENTERED] MemoryService.saveTurn', { userId, sessionId, userMessageLength: userMessage?.length, aiResponseLength: aiResponse?.length, ttl });
      _validateTurnInputs(userId, sessionId, userMessage, aiResponse);
      logger.memoryValidation(userId, sessionId, true);

      // ── Atomic Redis save ────────────────────────────────────────
      console.info('[CALL] WorkingMemoryRedis.saveConversationTurn', { userId, sessionId, userMessagePreview: String(userMessage).slice(0,80), aiResponsePreview: String(aiResponse).slice(0,80), ttl });
      saveStartedAt = Date.now();
      logger.log('STM_SAVE', { userId, sessionId, ttl, status: 'starting', ts: new Date().toISOString() });
      logger.stmSaveStart({ userId, sessionId, ttl, status: 'starting' });
      const result = await WorkingMemoryRedis.saveConversationTurn(
        userId, sessionId, userMessage, aiResponse, ttl
      );
      const saveDurationMs = Date.now() - saveStartedAt;
      traceLog('working_memory_save', {
        memoryTraceId,
        turnId: result && result.turnId,
        userId,
        sessionId,
        userMessage: String(userMessage || ''),
        assistantMessage: String(aiResponse || ''),
        totalTurns: result && result.totalTurns,
        success: Boolean(result && result.success !== false),
      });
      logger.stmSaveSuccess({ userId, sessionId, turnId: result.turnId, totalTurns: result.totalTurns, durationMs: saveDurationMs });
      logger.log('STM_SAVE', { userId, sessionId, turnId: result.turnId, totalTurns: result.totalTurns, ttl, durationMs: saveDurationMs, status: 'saved', ts: new Date().toISOString() });

      console.info('[RETURN] WorkingMemoryRedis.saveConversationTurn', { turnId: result && result.turnId, totalTurns: result && result.totalTurns });

      const sessionKey = _makeSessionKey(userId, sessionId);
      if (!stmSessionStates.has(sessionKey)) {
        _startSessionState(userId, sessionId);
      } else {
        _refreshSessionState(userId, sessionId);
      }

      logger.memorySaved(userId, sessionId, result.turnId);
      traceLog('memory_saved', {
        memoryTraceId,
        memoryType: 'working',
        memoryId: result.turnId,
        category: 'conversation',
        key: `memory:working:${userId}`,
        value: JSON.stringify({ userMessage, assistantMessage: aiResponse }),
        confidence: 1,
        sourceTurnId: result.turnId,
        sourceConversationId: sessionId,
        createdAt: new Date().toISOString(),
        storage: 'redis'
      });

      const output = {
        success:     true,
        memorySaved: true,
        turnId:      result.turnId,
        totalTurns:  result.totalTurns,
        ttl,
        timestamp:   new Date().toISOString(),
        memoryTraceId,
      };

      try {
        const { extractMemoryCandidates, extractCanonicalSemanticMemories } = require('./extraction');
        
        // CRITICAL FIX: Extract from user message and assistant message SEPARATELY
        // with source tracking. Never mix AI-generated text with user assertions about identity.
        
        // Process user message (primary evidence source for identity)
        const userExtracted = extractMemoryCandidates(userMessage, { 
          memoryTraceId, 
          sourceTurnId: result.turnId,
          sourceRole: 'user'  // User-originated statement
        });
        if (userExtracted.length) {
          logger.log('MEMORY_CANDIDATE_EXTRACTED_FROM_USER', {
            userId,
            sessionId,
            candidateCount: userExtracted.length,
            categories: userExtracted.map((candidate) => candidate.category),
            sample: userExtracted[0]?.value || '',
          });
        }

        // Process assistant message (lower priority for identity, only for contextual facts)
        const assistantExtracted = extractMemoryCandidates(aiResponse, { 
          memoryTraceId, 
          sourceTurnId: result.turnId,
          sourceRole: 'assistant'  // AI-generated text
        });
        if (assistantExtracted.length) {
          logger.log('MEMORY_CANDIDATE_EXTRACTED_FROM_ASSISTANT', {
            userId,
            sessionId,
            candidateCount: assistantExtracted.length,
            categories: assistantExtracted.map((candidate) => candidate.category),
            sample: assistantExtracted[0]?.value || '',
          });
        }

        // Extract canonical memories from user message only (primary identity source)
        const userCanonicalGroup = extractCanonicalSemanticMemories(userMessage, { 
          memoryTraceId, 
          sourceTurnId: result.turnId,
          sourceRole: 'user'
        });
        const userCanonicalEntries = Object.values(userCanonicalGroup).flat();
        
        if (userCanonicalEntries.length) {
          const saved = await WorkingMemoryRedis.upsertSemanticMemories(userId, userCanonicalGroup, { source: 'user', turnId: result.turnId });
          logger.log('MEMORY_CANONICAL_SEMANTIC_SAVED_FROM_USER', {
            userId,
            sessionId,
            savedCount: saved,
            categories: Object.keys(userCanonicalGroup),
            sample: userCanonicalEntries[0]?.value || '',
          });
        }

        // Extract canonical from assistant only for non-identity categories
        const assistantCanonicalGroup = extractCanonicalSemanticMemories(aiResponse, { 
          memoryTraceId, 
          sourceTurnId: result.turnId,
          sourceRole: 'assistant'
        });
        
        // Filter out identity facts from assistant extraction - they should NOT overwrite user identity
        const filteredAssistantGroup = {};
        for (const [category, items] of Object.entries(assistantCanonicalGroup)) {
          if (category === 'identity') {
            // Skip assistant-generated identity facts - they are never authoritative
            logger.log('MEMORY_ASSISTANT_IDENTITY_REJECTED', {
              userId,
              sessionId,
              rejectedFacts: items.map(i => i.value),
              reason: 'assistant_identity_never_overwrites_user_identity'
            });
            continue;
          }
          filteredAssistantGroup[category] = items;
        }

        const assistantCanonicalEntries = Object.values(filteredAssistantGroup).flat();
        if (assistantCanonicalEntries.length) {
          const saved = await WorkingMemoryRedis.upsertSemanticMemories(userId, filteredAssistantGroup, { source: 'assistant', turnId: result.turnId });
          logger.log('MEMORY_CANONICAL_SEMANTIC_SAVED_FROM_ASSISTANT', {
            userId,
            sessionId,
            savedCount: saved,
            categories: Object.keys(filteredAssistantGroup),
            sample: assistantCanonicalEntries[0]?.value || '',
          });
        }
      } catch (candidateError) {
        logger.logError('MEMORY_CANDIDATE_PIPELINE_ERROR', candidateError.message || String(candidateError), candidateError.stack || null, userId, sessionId);
      }

      console.info('[OUTPUT] MemoryService.saveTurn', { success: true, turnId: result.turnId, totalTurns: result.totalTurns });
      console.info('[EXITED] MemoryService.saveTurn', { userId, sessionId, timestamp: new Date().toISOString() });

      return output;

    } catch (err) {
      logger.stmSaveFail({ userId, sessionId, error: err.message || String(err), durationMs: Date.now() - (saveStartedAt || Date.now()) });
      logger.error('SAVE_TURN_ERROR', err, { userId, sessionId });
      console.error('[ERROR] MemoryService.saveTurn', { message: err && err.message ? err.message : String(err) });
      throw err;
    }
  },

  /**
   * Retrieve recent working-memory turns for a user.
   * Compatibility wrapper for legacy /api/working-memory routes.
   */
  async getRecentMemory(userId, limit = 100) {
    if (!userId) {
      return { success: true, turns: [], totalTurns: 0, contextSize: 0, timestamp: new Date().toISOString(), skipped: true, reason: 'missing_user_id' };
    }

    try {
      if (!userId) {
        throw new InvalidUserError(userId);
      }

      const turns = await WorkingMemoryRedis.getRecentMemory(userId);
      const limitedTurns = Array.isArray(turns) ? turns.slice(0, limit) : [];
      const totalTurns = limitedTurns.length;
      const contextSize = JSON.stringify(limitedTurns).length;

      logger.memoryRetrieved(userId, 0, totalTurns);

      return {
        success: true,
        turns: limitedTurns,
        totalTurns,
        contextSize,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      logger.error('GET_RECENT_MEMORY_ERROR', err, { userId });
      throw err;
    }
  },

  /**
   * Retrieve a compact working-memory snapshot.
   * Compatibility wrapper for the legacy controller.
   */
  async getWorkingMemory(userId, limit = 20) {
    try {
      if (!userId) {
        throw new InvalidUserError(userId);
      }

      const turns = await WorkingMemoryRedis.getRecentMemory(userId);
      const limitedTurns = Array.isArray(turns) ? turns.slice(0, limit) : [];
      const ttl = await WorkingMemoryRedis.getMemoryTTL(userId);

      logger.memoryRetrieved(userId, 0, limitedTurns.length);

      return {
        totalTurns: limitedTurns.length,
        turns: limitedTurns,
        ttl: ttl || -1,
      };
    } catch (err) {
      logger.error('GET_WORKING_MEMORY_ERROR', err, { userId });
      throw err;
    }
  },

  /**
   * Retrieve working memory ranked for a query.
   * Compatibility wrapper for legacy controller usage.
   */
  async retrieveWorkingMemory(userId, limit = 20) {
    return MemoryService.retrieveWorkingMemoryForQuery(userId, null, limit);
  },

  /**
   * Retrieve working memory with optional query-aware ranking.
   */
  async retrieveWorkingMemoryForQuery(userId, userQuery = null, limit = 20) {
    try {
      if (!userId) {
        throw new InvalidUserError(userId);
      }

      const turns = await WorkingMemoryRedis.getRecentMemory(userId);
      const rankedMemories = Array.isArray(turns) ? turns.slice(0, limit).reverse() : [];
      const memoriesFound = rankedMemories.length;

      logger.memoryRetrieved(userId, 0, memoriesFound);

      return {
        memoriesFound,
        rankedMemories,
        matchedCategory: null,
        confidence: 0,
      };
    } catch (err) {
      logger.error('RETRIEVE_WORKING_MEMORY_ERROR', err, { userId, userQuery });
      throw err;
    }
  },

  /**
   * Build a human-readable working-memory context for Gemini.
   * Compatibility wrapper for the legacy controller.
   */
  async buildWorkingMemoryContext(userId, currentUserMessage = '', currentAiMessage = '', limit = 20, charLimit = 3000) {
    try {
      if (!userId) {
        throw new InvalidUserError(userId);
      }

      const turns = await WorkingMemoryRedis.getRecentMemory(userId);
      const recentTurns = Array.isArray(turns) ? turns.slice(0, limit) : [];
      const context = recentTurns.map((turn) => {
        const assistant = String(turn.aiResponse || turn.assistantResponse || turn.assistantMessage || '').trim();
        return `User: ${turn.userMessage}\nAssistant: ${assistant}\n\n`;
      }).join('');

      const turnsUsed = recentTurns.length;

      logger.logPromptBuilder(userId, {
        status: 'finished',
        turnCount: turns.length,
        contextLength: context.length,
      });

      return {
        success: true,
        context,
        contextLength: context.length,
        turnsUsed,
        turns: recentTurns,
      };
    } catch (err) {
      logger.error('BUILD_WORKING_MEMORY_CONTEXT_ERROR', err, { userId });
      throw err;
    }
  },

  /**
   * Delete all working memory for a user.
   */
  async deleteUserMemory(userId) {
    try {
      if (!userId) {
        throw new InvalidUserError(userId);
      }

      const deleted = await WorkingMemoryRedis.deleteExpiredMemory(userId);

      return {
        success: true,
        deleted,
        userId,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      logger.error('DELETE_USER_MEMORY_ERROR', err, { userId });
      throw err;
    }
  },

  /**
   * Get working-memory statistics for a user.
   */
  async getMemoryStats(userId) {
    try {
      if (!userId) {
        throw new InvalidUserError(userId);
      }

      const size = await WorkingMemoryRedis.getMemorySize(userId);
      const ttl = await WorkingMemoryRedis.getMemoryTTL(userId);
      const turns = await WorkingMemoryRedis.getRecentMemory(userId);

      return {
        success: true,
        userId,
        conversationTurns: size,
        totalMessages: turns.length * 2,
        totalCharacters: JSON.stringify(turns).length,
        ttl: ttl > 0 ? ttl : 0,
        maxTurns: null,
        memoryUsagePercent: null,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      logger.error('GET_MEMORY_STATS_ERROR', err, { userId });
      throw err;
    }
  },

  /**
   * Health check for the working-memory Redis layer.
   */
  async getHealth() {
    try {
      const healthy = await WorkingMemoryRedis.isHealthy();
      return { healthy, timestamp: new Date().toISOString() };
    } catch (err) {
      logger.error('GET_WORKING_MEMORY_HEALTH_ERROR', err, {});
      return { healthy: false, timestamp: new Date().toISOString() };
    }
  },

  /**
   * Build the complete structured context string for Gemini.
   * Uses intelligent query-aware retrieval with escalation (STM → LTM → Deep).
   * 
   * CRITICAL: Never blocks Gemini Live. Uses timeouts and graceful degradation.
   *
   * @param {string} userId
   * @param {Object} [opts]
   * @param {string}  [opts.userQuery]       — current user prompt (enables intelligent retrieval)
   * @param {string}  [opts.sessionId]       — session ID for anti-repetition tracking
   * @param {boolean} [opts.isLiveContext]   — true if this is for Live (default true)
   * @returns {Promise<{systemPrompt:string, facts:Object[], task:Object|null, turnCount:number}>}
   */
  async prepareContext(userId, opts = {}) {
    const {
      userQuery = null,
      sessionId = userId,
      isLiveContext = true,
      activeContext = {},
    } = opts;

    if (!userId) {
      return { systemPrompt: '', facts: [], task: null, turnCount: 0, contextPacket: null, memoryEligible: false, skipped: true, reason: 'missing_user_id' };
    }

    if (sessionId && !isMemoryEligible(userId, sessionId)) {
      return { systemPrompt: '', facts: [], task: null, turnCount: 0, contextPacket: null, memoryEligible: false, skipped: true, reason: 'memory_gate_closed' };
    }

    try {
      if (!userId) return { systemPrompt: '', facts: [], task: null, turnCount: 0, contextPacket: null };

      // Use new intelligent retrieval orchestrator
      const retrievalStart = Date.now();
      const result = await memoryOrchestrator.retrieveMemoryWithEscalation(
        userId,
        sessionId,
        userQuery,
        { isLiveContext, activeContext }
      );
      const retrievalDuration = Date.now() - retrievalStart;

      traceLog('memory_retrieval_start', { memoryTraceId: createMemoryTraceId(), query: String(userQuery || ''), userId, sessionId });
      traceLog('working_memory_retrieved', { memoryTraceId: createMemoryTraceId(), count: Array.isArray(result.allMemories) ? result.allMemories.length : 0, memories: Array.isArray(result.allMemories) ? result.allMemories.slice(0, 10) : [] });
      logger.log('INTELLIGENT_RETRIEVAL', {
        userId,
        sessionId,
        durationMs: retrievalDuration,
        contextTokens: result.totalTokens,
        budgetUsagePercent: result.budgetUsagePercent,
        intent: result.queryAnalysis?.intent,
        memoriesRetrieved: result.retrievedMemoriesCount,
        userQuery: String(userQuery || '').slice(0, 180),
      });

      if (isLiveContext && retrievalDuration > 1000) {
        console.warn('[MEMORY_LIVE_SLOW]', `Memory retrieval took ${retrievalDuration}ms for Live context`);
      }

      logger.log('LIVE_CONTEXT_INJECTED', {
        userId,
        sessionId,
        contextLength: String(result.context || '').length,
        selectedCount: result.retrievedMemoriesCount || 0,
        source: result.queryAnalysis?.intent || 'unknown',
      });
      traceLog('memory_composer', {
        memoryTraceId: createMemoryTraceId(),
        workingMemory: Array.isArray(result.allMemories) ? result.allMemories.slice(0, 10) : [],
        episodicMemory: [],
        semanticMemory: [],
        selectedMemories: Array.isArray(result.allMemories) ? result.allMemories.slice(0, 10) : [],
        discardedMemories: [],
        selectionReasons: ['query_relevance'],
        finalMemoryContext: String(result.context || ''),
      });

      return {
        systemPrompt: result.context,
        facts: result.allMemories || [],
        task: null,
        turnCount: result.retrievedMemoriesCount || 0,
        contextPacket: result.contextPacket || null,
      };

    } catch (err) {
      logger.error('PREPARE_CONTEXT_ERROR', err, { userId, sessionId });
      return { systemPrompt: '', facts: [], task: null, turnCount: 0, contextPacket: null };
    }
  },


  /**
   * Health check — verifies Redis connection.
   * @returns {Promise<{healthy:boolean}>}
   */
  async health() {
    try {
      const healthy = await WorkingMemoryRedis.isHealthy();
      return { healthy, timestamp: new Date().toISOString() };
    } catch {
      return { healthy: false, timestamp: new Date().toISOString() };
    }
  },
};

module.exports = MemoryService;
