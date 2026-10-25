'use strict';
const { createHash } = require('node:crypto');

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
 *    → WorkingMemoryRedis.saveConversationTurn()    ← synchronous STM write
 *    → configured legacy/canonical durable-memory work runs in background
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
const UserModel = require('../../models/User');
const { InvalidUserError, MissingSessionError, EmptyMessageError } = require('../../utils/workingMemory/errors');
const { env } = require('../../config/env');

// ── Private sub-modules ─────────────────────────────────────────────
const promptBuilder   = require('./retrieval/promptBuilder');
const pineconeService = require('../pineconeService');
const { computeEmbedding } = require('../../utils/memory/memoryUtils');
const retriever = require('./retrieval/retriever');
const strictRetriever = require('./retrieval/strictRetriever');
const memoryOrchestrator = require('./utils/memoryRetrievelOrchestrator');
const antiRepetition = require('./utils/antiRepetitionTracker');
const { isMemoryEligible } = require('./memoryStabilityGate');
const { retrieveMemoryContext, saveConversationMemory } = require('./application');
const { INFRASTRUCTURE_FAILURES } = require('./application/memoryWriteAdapterContract');

// ── Config ─────────────────────────────────────────────────────────
const DEFAULT_TTL           = env.shortTermMemoryTTL;          // 25 minutes for conversation turns
// Retrieval is now driven by a time window rather than a fixed turn count.
const canonicalWriteJobs = new Map();

function _compareShadowRetrieval(oldResult = {}, canonicalResult = {}) {
  const oldMemories = Array.isArray(oldResult.allMemories) ? oldResult.allMemories : [];
  const newMemories = Array.isArray(canonicalResult.memories) ? canonicalResult.memories : [];

  return {
    oldHasData: oldMemories.length > 0,
    newHasData: newMemories.length > 0,
    oldCount: oldMemories.length,
    newCount: newMemories.length,
    oldContextLength: Number(oldResult.context?.length || 0),
    newContextLength: Number(canonicalResult.context?.length || 0),
    oldSources: oldResult.source || null,
    newSource: canonicalResult.source || null,
    oldTypes: [...new Set(oldMemories.map((memory) => String(memory?.type || '').trim()).filter(Boolean).slice(0, 8))],
    newTypes: [...new Set(newMemories.map((memory) => String(memory?.type || '').trim()).filter(Boolean).slice(0, 8))],
  };
}

function resolveCanonicalReadMode() {
  const configuredMode = String(env.memoryCanonicalReadMode || 'legacy').trim().toLowerCase();
  if (['legacy', 'shadow', 'canonical', 'canonical_with_legacy_fallback'].includes(configuredMode)) {
    return configuredMode;
  }
  return env.memoryCanonicalReadEnabled ? 'canonical' : 'legacy';
}

function buildSafeEmptyMemoryContext() {
  return {
    systemPrompt: '',
    facts: [],
    task: null,
    turnCount: 0,
    contextPacket: null,
    memoryRevision: 0,
    contextMemoryRevision: 0,
    source: 'none',
    memoryStatus: 'NO_MEMORY',
    ok: true,
  };
}

function buildFailedMemoryContext(error) {
  return {
    systemPrompt: '',
    facts: [],
    task: null,
    turnCount: 0,
    contextPacket: null,
    memoryRevision: 0,
    contextMemoryRevision: 0,
    source: 'none',
    memoryStatus: 'RETRIEVAL_FAILURE',
    errorCode: error?.code || error?.name || 'MEMORY_RETRIEVAL_FAILURE',
    ok: false,
  };
}

function buildContextFromLegacyResult(result = {}) {
  if (!result || typeof result !== 'object') {
    return buildSafeEmptyMemoryContext();
  }

  const facts = Array.isArray(result.allMemories) ? result.allMemories : [];
  const systemPrompt = String(result.context || '');
  return {
    systemPrompt,
    facts,
    task: null,
    turnCount: result.retrievedMemoriesCount || 0,
    contextPacket: result.contextPacket || null,
    memoryRevision: result.memoryRevision || 0,
    contextMemoryRevision: result.contextMemoryRevision || result.memoryRevision || 0,
    source: result.source || 'legacy',
    memoryContextIncluded: facts.length > 0 && Boolean(systemPrompt.trim()),
    ok: true,
  };
}

async function loadAuthenticatedIdentity(userId) {
  const startedAt = Date.now();
  try {
    const user = await UserModel.findById(userId)
      .select('firstName lastName displayName')
      .maxTimeMS(env.memoryMongoQueryTimeoutMs)
      .lean();
    const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || user?.displayName || '';
    const status = fullName ? 'AVAILABLE' : (user ? 'NO_PROFILE_NAME' : 'PROFILE_NOT_FOUND');
    return { fullName, status, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    const lookupError = new Error('Authoritative user profile lookup failed.');
    lookupError.code = 'USER_PROFILE_LOOKUP_FAILED';
    throw lookupError;
  }
}

function buildAuthenticatedIdentityContext(identity, canonicalContext = '') {
  const existingSections = String(canonicalContext || '')
    .split(/\r?\n\r?\n/)
    .map((section) => section.trim())
    .filter((section) => section && !section.startsWith('=== Authenticated Identity ==='));
  const contextWithoutIdentity = existingSections.join('\n\n');
  const identitySection = identity?.fullName
    ? `=== Authenticated Identity ===\nUser full name: ${identity.fullName}`
    : '';

  return [identitySection, contextWithoutIdentity].filter(Boolean).join('\n\n');
}

function withAuthenticatedIdentity(result, identity) {
  const systemPrompt = buildAuthenticatedIdentityContext(identity, result.systemPrompt || result.context || '');
  return {
    ...result,
    systemPrompt,
    context: systemPrompt,
    identityStatus: identity.status,
    identityLookupMs: identity.elapsedMs,
  };
}

function buildContextFromCanonicalResult(canonical = {}) {
  const memories = Array.isArray(canonical.memories) ? canonical.memories : [];
  return {
    systemPrompt: canonical.context || '',
    facts: memories,
    task: null,
    turnCount: memories.length,
    contextPacket: null,
    memoryRevision: 0,
    contextMemoryRevision: 0,
    source: canonical.source || 'canonical',
    memoryStatus: canonical.ok === false
      ? 'RETRIEVAL_FAILURE'
      : (canonical.metadata?.status === 'PARTIAL'
        ? 'PARTIAL'
        : (memories.length ? 'MEMORY_FOUND' : 'NO_MEMORY')),
    memoryContextIncluded: memories.length > 0 && Boolean(String(canonical.context || '').trim()),
    retrievalMetadata: canonical.metadata || null,
    errorCode: canonical.error?.code
      || (canonical.metadata?.status === 'PARTIAL' ? 'PARTIAL_MEMORY_SOURCE_FAILURE' : null),
    ok: canonical.ok !== false,
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
    return [];
  }

  try {
    // Delegate to retriever wrapper which handles analysis, namespace selection,
    // multi-namespace querying, scoring, and deduplication.
    const res = await retriever.retrieve({ userId, query: userQuery, topK: 6 });
    const results = Array.isArray(res.results) ? res.results : [];
    return results;
  } catch (err) {
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
async function _runBackgroundExtraction(userId, sessionId, userMessage, aiResponse, turnId) {
  const semanticStatus = {
    status: 'NOT_MEMORY_WORTHY',
    saved: false,
    count: 0,
    dependency: null,
    queued: false,
  };

  try {
    const { extractMemoryCandidates, extractCanonicalSemanticMemories } = require('./extraction');
    const { shouldUseSemanticUnderstanding, understandUserMemory } = require('./semanticMemoryUnderstanding');

    const userExtracted = extractMemoryCandidates(userMessage, { sourceTurnId: turnId, sourceRole: 'user' });
    const assistantExtracted = extractMemoryCandidates(aiResponse, { sourceTurnId: turnId, sourceRole: 'assistant' });
    if (!userExtracted.length && !assistantExtracted.length) {
      return semanticStatus;
    }

    const deterministicUserCanonicalGroup = /[?؟]$/.test(String(userMessage || '').trim())
      ? {}
      : extractCanonicalSemanticMemories(userMessage, { sourceTurnId: turnId, sourceRole: 'user' });

    const semanticUserCanonicalGroup = shouldUseSemanticUnderstanding(userMessage, deterministicUserCanonicalGroup)
      ? await Promise.race([
          understandUserMemory(userMessage, { userId, sourceTurnId: turnId }),
          new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
        ])
      : null;

    const userCanonicalGroup = semanticUserCanonicalGroup === null
      ? deterministicUserCanonicalGroup
      : (Object.keys(semanticUserCanonicalGroup || {}).length ? semanticUserCanonicalGroup : {});

    if (semanticUserCanonicalGroup === null && Object.keys(deterministicUserCanonicalGroup).length === 0) {
      semanticStatus.status = 'UNAVAILABLE_DEPENDENCY';
      semanticStatus.dependency = 'semantic_understanding';
    }

    const userCanonicalEntries = Object.values(userCanonicalGroup || {}).flat();
    if (userCanonicalEntries.length) {
      semanticStatus.status = 'STORAGE_FAILURE';
      const saved = await WorkingMemoryRedis.upsertSemanticMemories(userId, userCanonicalGroup, { source: 'user', turnId });
      semanticStatus.saved = saved > 0;
      semanticStatus.count = saved;
      semanticStatus.status = saved > 0 ? 'SUCCESS' : 'STORAGE_FAILURE';
    } else if (semanticStatus.status !== 'UNAVAILABLE_DEPENDENCY') {
      semanticStatus.status = 'NOT_MEMORY_WORTHY';
    }

    return semanticStatus;
  } catch (candidateError) {
    const message = String(candidateError?.message || '');
    semanticStatus.status = /gemini/i.test(message) ? 'UNAVAILABLE_DEPENDENCY' : 'STORAGE_FAILURE';
    semanticStatus.dependency = candidateError?.code || candidateError?.name || 'semantic_pipeline';
    return semanticStatus;
  }
}

function resolveCanonicalWriteMode() {
  const mode = String(env.memoryCanonicalWriteMode || 'legacy').trim().toLowerCase();
  return ['legacy', 'shadow', 'canonical', 'canonical_with_legacy_fallback'].includes(mode)
    ? mode
    : 'legacy';
}

function logMemoryWriteFailure(mode, status, code, category, details = {}) {
  const diagnostics = details.extractionDiagnostics || {};
  const safeName = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
    ? value
    : undefined;
  const turnId = typeof details.turnId === 'string' && details.turnId
    ? createHash('sha256').update(details.turnId).digest('hex').slice(0, 16)
    : undefined;
  const failureStage = status === 'EXTRACTION_FAILURE' && diagnostics.stage
    ? diagnostics.stage
    : (details.writeStage
      || diagnostics.stage
      || (status === 'MONGO_FAILURE' ? 'canonical_persistence' : 'extraction'));
  console.error('[MEMORY_WRITE_FAILURE]', JSON.stringify({
    mode,
    status,
    code: code || status,
    ...(category ? { category } : {}),
    ...(turnId ? { correlationId: turnId } : {}),
    failureStage,
    ...(details.writeStage ? { writeStage: details.writeStage } : {}),
    ...(typeof details.extractionDecision === 'string'
      ? { extractionDecision: details.extractionDecision }
      : {}),
    ...(typeof details.validationFailureCode === 'string'
      ? { validationFailureCode: details.validationFailureCode }
      : {}),
    ...(diagnostics.stage ? { extractionStage: diagnostics.stage } : {}),
    ...(safeName(diagnostics.providerOperation) ? { providerOperation: diagnostics.providerOperation } : {}),
    ...(safeName(diagnostics.errorClass || details.errorClass)
      ? { errorClass: diagnostics.errorClass || details.errorClass }
      : {}),
    ...(safeName(diagnostics.providerCategory) ? { providerCategory: diagnostics.providerCategory } : {}),
    ...(safeName(diagnostics.providerRequestId) ? { providerRequestId: diagnostics.providerRequestId } : {}),
    ...(Number.isInteger(diagnostics.providerStatus) ? { providerStatus: diagnostics.providerStatus } : {}),
    inputPresent: details.inputPresent === true,
    ...(typeof diagnostics.responseContentPresent === 'boolean'
      ? { responseContentPresent: diagnostics.responseContentPresent }
      : {}),
    ...(typeof diagnostics.parsingSucceeded === 'boolean'
      ? { parsingSucceeded: diagnostics.parsingSucceeded }
      : {}),
    ...(typeof diagnostics.validationSucceeded === 'boolean'
      ? { validationSucceeded: diagnostics.validationSucceeded }
      : {}),
    ...(Number.isInteger(details.retryCount) ? { retryCount: details.retryCount } : {}),
    ...(Number.isFinite(details.durationMs) ? { durationMs: details.durationMs } : {}),
    ...(Number.isFinite(details.extractionDurationMs)
      ? { extractionDurationMs: details.extractionDurationMs }
      : {}),
    ...(Number.isInteger(details.candidateCount) ? { candidateCount: details.candidateCount } : {}),
    ...(Array.isArray(details.decisions)
      ? { canonicalDecisions: details.decisions.map(({ decision, code }) => ({ decision, ...(code ? { code } : {}) })) }
      : {}),
    ...(typeof details.persistenceAttempted === 'boolean'
      ? { persistenceAttempted: details.persistenceAttempted }
      : {}),
    ...(typeof details.mongoAcknowledged === 'boolean' || details.mongoAcknowledged === null
      ? { mongoAcknowledged: details.mongoAcknowledged }
      : {}),
    ...(typeof details.mongoStatus === 'string' ? { mongoStatus: details.mongoStatus } : {}),
    timedOut: code === 'NETWORK_TIMEOUT',
    persistenceConfirmed: false,
  }));
}

function scheduleCanonicalWrite({
  mode,
  userId,
  sessionId,
  userMessage,
  aiResponse,
  timestamp,
  source,
  turnId,
}) {
  const jobKey = `${userId}:${turnId}`;
  if (canonicalWriteJobs.has(jobKey)) {
    return false;
  }

  const job = new Promise((resolve) => setImmediate(resolve))
    .then(() => saveConversationMemory({
        userId,
        sessionId,
        userMessage,
        assistantMessage: aiResponse,
        timestamp,
        source,
        options: {
          conversationTurnId: turnId,
          dryRun: mode === 'shadow',
        },
      }))
    .then(async (result) => {
      if (['EXTRACTION_FAILURE', 'CONSOLIDATION_FAILURE', 'MONGO_FAILURE'].includes(result?.status)) {
        logMemoryWriteFailure(
          mode,
          result.status,
          result?.metadata?.extractionFailureCode || result?.error?.code,
          result?.metadata?.extractionFailureCategory,
          {
            turnId,
            inputPresent: true,
            extractionDiagnostics: result?.metadata?.extractionDiagnostics,
            extractionDecision: result?.metadata?.extractionDecision,
            writeStage: result?.metadata?.writeStage,
            candidateCount: result?.metadata?.candidateCount,
            decisions: result?.metadata?.decisions,
            persistenceAttempted: result?.metadata?.persistenceAttempted,
            mongoAcknowledged: result?.metadata?.mongoAcknowledged,
            mongoStatus: result?.metadata?.mongoStatus,
            durationMs: result?.metadata?.latency?.totalLatencyMs,
            extractionDurationMs: result?.metadata?.latency?.extractionLatencyMs,
          },
        );
      }
      if (mode === 'canonical_with_legacy_fallback'
        && INFRASTRUCTURE_FAILURES.has(result?.status)) {
        const legacyResult = await _runBackgroundExtraction(
          userId,
          sessionId,
          userMessage,
          aiResponse,
          turnId,
        );
        if (INFRASTRUCTURE_FAILURES.has(legacyResult?.status)) {
          logMemoryWriteFailure(mode, legacyResult?.status || 'STORAGE_FAILURE', result.status);
        }
      }
    })
    .catch(async (error) => {
        logMemoryWriteFailure(mode, 'EXTRACTION_FAILURE', 'MEMORY_WRITE_JOB_FAILURE', 'INFRASTRUCTURE', {
          turnId,
          inputPresent: true,
          errorClass: error?.name,
        });
        if (mode === 'canonical_with_legacy_fallback') {
          try {
            const legacyResult = await _runBackgroundExtraction(
              userId,
              sessionId,
              userMessage,
              aiResponse,
              turnId,
            );
            if (INFRASTRUCTURE_FAILURES.has(legacyResult?.status)) {
              logMemoryWriteFailure(mode, legacyResult?.status || 'STORAGE_FAILURE', 'LEGACY_WRITE_FAILURE');
            }
          } catch {
            console.error('[MEMORY_WRITE_FAILURE]', JSON.stringify({
              code: 'LEGACY_WRITE_FAILURE',
            }));
          }
        }
    })
    .finally(() => {
      canonicalWriteJobs.delete(jobKey);
    });

  canonicalWriteJobs.set(jobKey, job);
  return true;
}

async function drainCanonicalWriteJobs(timeoutMs = 8000) {
  const pending = [...canonicalWriteJobs.values()];
  if (!pending.length) return { drained: true, pending: 0 };

  let timeout;
  const completed = await Promise.race([
    Promise.allSettled(pending).then(() => true),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return {
    drained: completed,
    pending: completed ? 0 : canonicalWriteJobs.size,
  };
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
  async saveTurn({
    userId,
    sessionId,
    userMessage,
    aiResponse,
    ttl = DEFAULT_TTL,
    conversationTurnId = null,
    timestamp = null,
    source = 'CONVERSATION',
  }) {
    if (!userId || !sessionId) {
      return { success: false, memorySaved: false, turnId: null, totalTurns: 0, ttl, timestamp: new Date().toISOString(), skipped: true, reason: 'missing_user_or_session' };
    }

    if (!isMemoryEligible(userId, sessionId)) {
      return { success: false, memorySaved: false, turnId: null, totalTurns: 0, ttl, timestamp: new Date().toISOString(), skipped: true, reason: 'memory_gate_closed' };
    }

    let saveStartedAt = Date.now();
    const semanticStatus = {
      status: 'NOT_MEMORY_WORTHY',
      saved: false,
      count: 0,
      dependency: null,
    };
    try {
      const normalizedText = String(userMessage || '').replace(/\s+/g, ' ').trim();
      _validateTurnInputs(userId, sessionId, userMessage, aiResponse);

      // ── Atomic Redis save ────────────────────────────────────────
      saveStartedAt = Date.now();
      const result = await WorkingMemoryRedis.saveConversationTurn(
        userId, sessionId, userMessage, aiResponse, ttl, { conversationTurnId }
      );
      if (result?.duplicate) {
        return result;
      }
      const saveDurationMs = Date.now() - saveStartedAt;


      const mode = resolveCanonicalWriteMode();
      const occurredAt = timestamp || new Date().toISOString();
      const output = {
        success:     true,
        memorySaved: true,
        turnId:      result.turnId,
        totalTurns:  result.totalTurns,
        ttl,
        timestamp:   new Date().toISOString(),
        stm: { status: 'SUCCESS', saved: true, turnId: result.turnId, latencyMs: saveDurationMs },
        canonicalSemantic: {
          status: 'QUEUED',
          saved: false,
          count: 0,
          dependency: 'semantic_pipeline',
          queued: true,
        },
      };

      if (mode === 'legacy' || mode === 'shadow') {
        const backgroundSemanticStatus = _runBackgroundExtraction(
          userId, sessionId, userMessage, aiResponse, result.turnId
        );
        const semanticStatusResult = await Promise.race([
          backgroundSemanticStatus,
          new Promise((resolve) => {
            setTimeout(() => resolve({
              status: 'QUEUED',
              saved: false,
              count: 0,
              dependency: 'semantic_pipeline',
              queued: true,
              timedOut: true,
            }), 1200);
          }),
        ]);
        output.canonicalSemantic = semanticStatusResult || output.canonicalSemantic;
      }

      if (mode !== 'legacy') {
        scheduleCanonicalWrite({
          mode,
          userId,
          sessionId,
          userMessage,
          aiResponse,
          timestamp: occurredAt,
          source,
          turnId: conversationTurnId || result.turnId,
        });
        output.canonicalWrite = {
          mode,
          status: 'QUEUED',
          queued: true,
        };
      }

      return output;

    } catch (err) {
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


      return {
        success: true,
        turns: limitedTurns,
        totalTurns,
        contextSize,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
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


      return {
        totalTurns: limitedTurns.length,
        turns: limitedTurns,
        ttl: ttl || -1,
      };
    } catch (err) {
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
      const rankedMemories = Array.isArray(turns) ? [...turns].slice(0, limit) : [];
      const memoriesFound = rankedMemories.length;


      return {
        memoriesFound,
        rankedMemories,
        matchedCategory: null,
        confidence: 0,
      };
    } catch (err) {
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
      const recentTurns = Array.isArray(turns) ? [...turns].slice(0, limit) : [];
      const turnContext = recentTurns.map((turn) => {
        const assistant = String(turn.aiResponse || turn.assistantResponse || turn.assistantMessage || '').trim();
        return `User: ${turn.userMessage}\nAssistant: ${assistant}\n\n`;
      }).join('');

      const semantic = await WorkingMemoryRedis.getSemanticMemories(userId);
      const semanticEntries = Object.values(semantic || {}).flat().filter(Boolean);
      const semanticContext = semanticEntries.length
        ? `Current structured memory:\n${semanticEntries.map((item) => `${item.category || 'memory'}: ${item.value}`).join('\n')}\n\n`
        : '';
      const context = `${semanticContext}${turnContext}`;

      const turnsUsed = recentTurns.length;

      return {
        success: true,
        context,
        contextLength: context.length,
        turnsUsed,
        turns: recentTurns,
      };
    } catch (err) {
      throw err;
    }
  },

  /**
   * Delete all working memory for a user.
   */
  async deleteSemanticMemory(userId, requestText = '') {
    try {
      if (!userId || !String(requestText || '').trim()) {
        return { success: false, deleted: 0, userId, reason: 'missing_user_or_request' };
      }

      const text = String(requestText || '').trim();
      const { analyzeQuery } = require('./utils/queryAnalyzer');
      const analysis = analyzeQuery(text, {});
      const lower = text.toLowerCase();
      const isForgetRequest = analysis.intent === 'memory_delete' || /(forget|delete|remove|bhool|mita|mat\s+rakhna|yaad\s+mat)/i.test(lower);
      if (!isForgetRequest) {
        return { success: false, deleted: 0, userId, reason: 'not_a_delete_request' };
      }

      const semantic = await WorkingMemoryRedis.getSemanticMemories(userId);
      const categoryHints = [];
      if (/(preference|favorite|pasand|like|color|food|movie|song|book|drink|music|taste)/i.test(lower)) categoryHints.push('preference');
      if (/(goal|target|objective|plan|startup|aim|ambition|dream)/i.test(lower)) categoryHints.push('goal');
      if (/(identity|name|naam)/i.test(lower)) categoryHints.push('identity');
      if (/(skill|coding|programming|design|learning|practice)/i.test(lower)) categoryHints.push('skill');
      if (/(project|build|develop|app|website|product)/i.test(lower)) categoryHints.push('project');
      if (/(relationship|friend|brother|sister|mother|father|family)/i.test(lower)) categoryHints.push('relationship');
      if (/(fact|study|ai|ml|python|course|topic|learning)/i.test(lower)) categoryHints.push('fact');

      const allActiveEntries = Object.values(semantic).flat();
      const valueCriteria = [];
      for (const item of allActiveEntries) {
        const value = String(item.value || '').toLowerCase();
        const category = String(item.category || '').toLowerCase();
        if (value && lower.includes(value)) {
          valueCriteria.push({ category, attribute: item.attribute || item.key, value: item.value });
        }
      }

      const deleteCriteria = valueCriteria.length
        ? valueCriteria
        : categoryHints.map((category) => ({ category }));

      const uniqueCriteria = deleteCriteria.filter((criterion, index, arr) => {
        const serial = JSON.stringify(criterion);
        return arr.findIndex((entry) => JSON.stringify(entry) === serial) === index;
      });

      const deletedCount = uniqueCriteria.length ? await WorkingMemoryRedis.deleteSemanticMemories(userId, uniqueCriteria) : 0;
      const remaining = await WorkingMemoryRedis.getSemanticMemories(userId);
      const deletedValues = allActiveEntries
        .filter((item) => uniqueCriteria.some((criterion) => {
          if (criterion.category && String(item.category || '').toLowerCase() !== String(criterion.category).toLowerCase()) return false;
          if (criterion.attribute && String(item.attribute || item.key || '').toLowerCase() !== String(criterion.attribute).toLowerCase()) return false;
          if (criterion.value && !String(item.value || '').toLowerCase().includes(String(criterion.value).toLowerCase())) return false;
          return true;
        }))
        .map((item) => item.value);

      return {
        success: deletedCount > 0 || uniqueCriteria.length === 0,
        deleted: deletedCount,
        userId,
        requestText: text,
        deletedValues,
        remainingActive: Object.values(remaining).flat().length,
        timestamp: new Date().toISOString(),
        reason: deletedCount > 0 || uniqueCriteria.length === 0 ? 'semantic_memory_delete_processed' : 'nothing_matched',
      };
    } catch (err) {
      return { success: false, deleted: 0, userId, reason: err.message || 'delete_failed' };
    }
  },

  async getMemoryLineage(userId, memoryId) {
    if (!userId || !memoryId) {
      return null;
    }
    return WorkingMemoryRedis.getMemoryLineage(userId, memoryId);
  },

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

    let identity;
    try {
      identity = await loadAuthenticatedIdentity(userId);
    } catch (error) {
      return {
        ...buildFailedMemoryContext(error),
        identityStatus: 'LOOKUP_FAILED',
      };
    }

    if (sessionId && !isMemoryEligible(userId, sessionId)) {
      return withAuthenticatedIdentity({
        ...buildSafeEmptyMemoryContext(),
        memoryStatus: 'MEMORY_GATE_CLOSED',
        memoryEligible: false,
        skipped: true,
        reason: 'memory_gate_closed',
      }, identity);
    }

    try {
      const mode = resolveCanonicalReadMode();
      const canonicalOptions = {
        maxMemories: 6,
        maxContextLength: 1800,
        traceId: String(opts.traceId || 'untraced'),
        ...(isLiveContext ? {
          sourceTimeoutMs: env.liveMemoryRetrievalTimeoutMs,
          retrievalTimeoutMs: env.liveMemoryRetrievalTimeoutMs,
        } : {}),
      };

      if (mode === 'legacy') {
        const result = await memoryOrchestrator.retrieveMemoryWithEscalation(
          userId,
          sessionId,
          userQuery,
          { isLiveContext, activeContext }
        );
        const legacyContext = buildContextFromLegacyResult(result);
        return withAuthenticatedIdentity(legacyContext, identity);
      }

      if (mode === 'shadow') {
        const legacyResult = await memoryOrchestrator.retrieveMemoryWithEscalation(
          userId,
          sessionId,
          userQuery,
          { isLiveContext, activeContext }
        );

        try {
          const canonical = await retrieveMemoryContext({
            userId,
            query: userQuery || '',
            sessionId,
            options: canonicalOptions,
          });
          if (canonical && canonical.ok !== undefined) {
            _compareShadowRetrieval(legacyResult || {}, canonical || {});
          }
        } catch {
          // shadow diagnostics are intentionally non-blocking
        }
        const legacyContext = buildContextFromLegacyResult(legacyResult);
        return withAuthenticatedIdentity(legacyContext, identity);
      }

      if (mode === 'canonical') {
        const canonical = await retrieveMemoryContext({
          userId,
          query: userQuery || '',
          sessionId,
          options: canonicalOptions,
        });

        if (canonical && canonical.ok === false) {
          return withAuthenticatedIdentity(buildContextFromCanonicalResult(canonical), identity);
        }

        const canonicalResult = canonical || { ok: true, memories: [], context: '', source: 'none' };
        return withAuthenticatedIdentity(buildContextFromCanonicalResult(canonicalResult), identity);
      }

      if (mode === 'canonical_with_legacy_fallback') {
        const canonical = await retrieveMemoryContext({
          userId,
          query: userQuery || '',
          sessionId,
          options: canonicalOptions,
        });

        if (canonical && canonical.ok === true) {
          return withAuthenticatedIdentity(buildContextFromCanonicalResult(canonical), identity);
        }

        try {
          const legacyResult = await memoryOrchestrator.retrieveMemoryWithEscalation(
            userId,
            sessionId,
            userQuery,
            { isLiveContext, activeContext }
          );
          const legacyContext = buildContextFromLegacyResult(legacyResult);
          return withAuthenticatedIdentity(legacyContext, identity);
        } catch (error) {
          return withAuthenticatedIdentity(buildFailedMemoryContext(error), identity);
        }
      }

      const result = await memoryOrchestrator.retrieveMemoryWithEscalation(
        userId,
        sessionId,
        userQuery,
        { isLiveContext, activeContext }
      );
      const legacyContext = buildContextFromLegacyResult(result);
      return withAuthenticatedIdentity(legacyContext, identity);
    } catch (err) {
      return withAuthenticatedIdentity(buildFailedMemoryContext(err), identity);
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
MemoryService.drainCanonicalWriteJobs = drainCanonicalWriteJobs;
