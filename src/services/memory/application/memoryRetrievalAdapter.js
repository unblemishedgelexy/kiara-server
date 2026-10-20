'use strict';

const { MemoryRetriever } = require('../retrieval/memoryRetriever');
const { routeMemorySources } = require('../retrieval/sourceRouter');
const { buildUnifiedContext } = require('../retrieval/unifiedMemoryContextBuilder');
const { planMemoryQuery: defaultPlanMemoryQuery } = require('../retrieval/memoryQueryPlanner');
const { StmMemoryAdapter } = require('../stm/stmMemoryAdapter');
const { env } = require('../../../config/env');
const {
  normalizeOptions,
  validateUserId,
  createNoMemoryResult,
  createFailureResult,
  safeMemorySummary,
  hashIdentifier,
} = require('./memoryRetrievalAdapterContract');

const STOP_WORDS = new Set(['actually', 'today', 'just', 'said', 'say', 'tell', 'told', 'you', 'i', 'am', 'is', 'the', 'my', 'user', 'prefer', 'prefers', 'use', 'using', 'switched', 'from', 'to', 'now']);
const UPDATE_CUES = /\b(switched|switching|no longer|don't use|do not use|stopped using|instead|now use|now prefer|changed to|moved to)\b/i;
const DEFAULT_SOURCE_TIMEOUT_MS = 10000;

function withSourceTimeout(operation, timeoutMs, code, onLateSettlement) {
  let timeout;
  let timedOut = false;
  const startedAt = Date.now();
  const sourcePromise = Promise.resolve().then(operation);
  sourcePromise.then(
    () => {
      if (timedOut) onLateSettlement?.('completed', Date.now() - startedAt, null);
    },
    (error) => {
      if (timedOut) onLateSettlement?.('failed', Date.now() - startedAt, error?.code || error?.name || 'SOURCE_FAILURE');
    },
  );
  return Promise.race([
    sourcePromise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        const error = new Error('Memory source retrieval timed out.');
        error.code = code;
        reject(error);
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

function contentOf(memory) {
  return `${memory.subject || ''} ${memory.predicate || ''} ${memory.value || ''} ${memory.content || ''}`;
}

function normalizedTokens(value) {
  return normalizeText(value).split(' ').filter((token) => token && !STOP_WORDS.has(token));
}

function isEquivalentRecentFact(stm, durable) {
  if (!stm || !durable || stm.source !== 'stm') return false;
  const statement = normalizeText(`${stm.userMessage || ''} ${stm.assistantMessage || ''}`);
  if (conflictsWithRecentUpdate(stm, durable)) return false;
  const value = normalizeText(durable.value);
  if (value.length >= 3 && statement.includes(value)) {
    return /\b(prefer|like|love|use|using|build|building|work|working|project|switched|changed)\b/i.test(statement);
  }

  const recentTokens = new Set(normalizedTokens(statement));
  const durableTokens = [...new Set(normalizedTokens(contentOf(durable)))];
  const matches = durableTokens.filter((token) => recentTokens.has(token)).length;
  const similarity = matches / Math.max(new Set(durableTokens).size, recentTokens.size, 1);
  const subject = normalizeText(durable.subject);
  const categoryRegex = /\b(?:healthcare|gaming|medical|education|ecommerce|social|fintech|enterprise|retail|logistics|analytics)\b/i;
  const statementCategory = categoryRegex.exec(statement)?.[0]?.toLowerCase();
  const contentCategory = categoryRegex.exec(contentOf(durable))?.[0]?.toLowerCase();
  const categoriesMismatch = (statementCategory || contentCategory) && statementCategory !== contentCategory;
  const sameProject = String(durable.type || '').toLowerCase() === 'project'
    && !categoriesMismatch
    && /\b(project|building|working|build)\b/i.test(statement)
    && ((subject.length > 3 && statement.includes(subject)) || matches >= 2);
  return sameProject || (matches >= 2 && similarity >= 0.55);
}

function conflictsWithRecentUpdate(stm, durable) {
  if (!stm || !durable || stm.source !== 'stm' || !UPDATE_CUES.test(stm.userMessage || '')) return false;
  const statement = normalizeText(stm.userMessage);
  const oldValueFull = normalizeText(durable.value);
  const oldValueMain = normalizeText(durable.value).split(' ')[0];
  const oldValues = [...new Set([oldValueFull, normalizeText(durable.content)].filter(Boolean))];
  if (!oldValues.length && !oldValueMain) return false;
  const matches = oldValues.some((value) => statement.includes(value))
    || (oldValueMain.length >= 3 && statement.includes(oldValueMain));
  if (!matches) return false;
  const newValueMatch = statement.match(/\b(?:to|now use|now prefer|changed to|moved to)\s+(.+?)(?:\s+(?:instead|from|because|but)\b|$)/i);
  const newValue = normalizeText(newValueMatch?.[1]);
  if (newValue && oldValues.some((value) => newValue === value || newValue.startsWith(`${value} `))) return false;
  return true;
}

function mergeCandidates(stmMemories = [], canonicalMemories = [], query = '') {
  const merged = new Map();
  for (const memory of canonicalMemories) {
    const id = String(memory.id || '').trim();
    if (!id) continue;
    const current = merged.get(id);
    if (!current || Number(memory.version || 0) >= Number(current.version || 0)) {
      merged.set(id, {
        ...memory,
        retrievalSource: 'long_term',
        retrievalSources: memory.semanticScore === undefined ? ['long_term'] : ['long_term', 'semantic'],
      });
    }
  }

  const durable = [...merged.values()];
  const recentCandidates = [];
  for (const recent of stmMemories) {
    const equivalent = durable.find((memory) => isEquivalentRecentFact(recent, memory));
    if (equivalent) {
      equivalent.recentEvidence = {
        timestamp: recent.timestamp,
        statement: recent.userMessage,
      };
      continue;
    }

    const conflicts = durable.filter((memory) => conflictsWithRecentUpdate(recent, memory));
    const currentSignal = UPDATE_CUES.test(recent.userMessage || '')
      || /\b(current|currently|now|today|just|recently)\b/i.test(query);
    recentCandidates.push({
      ...recent,
      currentCandidate: Boolean(currentSignal),
      conflict: conflicts.length > 0,
    });
    for (const memory of conflicts) {
      memory.conflict = true;
      memory.historicalCandidate = true;
    }
  }

  return [...recentCandidates, ...durable];
}

function rankUnifiedCandidates(candidates, query, analysis, maxMemories) {
  const stmCurrent = /\b(current|currently|now|today|just|recently|switched)\b/i.test(query);
  return candidates
    .map((candidate, index) => {
      if ((candidate.retrievalSource || candidate.source) === 'stm') {
        const overlap = normalizedTokens(`${candidate.userMessage || ''} ${candidate.assistantMessage || ''}`)
          .filter((token) => normalizedTokens(query).includes(token)).length;
        return {
          ...candidate,
          unifiedScore: (candidate.currentCandidate ? 3 : 1) + overlap * 0.08 + (stmCurrent ? 0.5 : 0),
          rankingReasons: ['source:stm', ...(candidate.currentCandidate ? ['recent_explicit_update'] : [])],
          _index: index,
        };
      }

      const baseScore = Number(candidate.score || candidate.retrievalScore?.score || 0);
      return {
        ...candidate,
        unifiedScore: baseScore + (candidate.conflict ? -1 : 0),
        rankingReasons: candidate.reasons || [],
        _index: index,
      };
    })
    .sort((left, right) => right.unifiedScore - left.unifiedScore || left._index - right._index)
    .slice(0, maxMemories)
    .map(({ _index, ...candidate }) => candidate);
}

function getUsedSources(memories) {
  const sources = new Set();
  for (const memory of memories) {
    if ((memory.retrievalSource || memory.source) === 'stm') sources.add('stm');
    else {
      sources.add('long_term');
      for (const source of memory.retrievalSources || []) {
        if (source === 'semantic') sources.add('semantic');
      }
    }
  }
  return ['stm', 'long_term', 'semantic'].filter((source) => sources.has(source));
}

function createMemoryRetrievalAdapter({
  stmAdapter = new StmMemoryAdapter(),
  retrieverFactory = () => new MemoryRetriever(),
  sourceTimeoutMs = DEFAULT_SOURCE_TIMEOUT_MS,
  plannerEnabled = env.memoryGroqQueryPlannerEnabled,
  planMemoryQuery = defaultPlanMemoryQuery,
} = {}) {
  async function retrieveMemoryContext({ userId, query, sessionId, options = {} } = {}) {
    const startedAt = Date.now();

    try {
      const normalizedUserId = validateUserId(userId);
      const normalizedOptions = normalizeOptions(options || {});
      const traceId = String(options?.traceId || 'untraced');
      const text = String(query || '').trim();
      const route = routeMemorySources(text, normalizedOptions);
      const analysis = route.analysis;
      const sourceErrors = {};
      const attemptedSources = new Set();
      let stmMemories = [];
      let canonicalMemories = [];
      let canonicalResult = null;
      let sourceLatencyMs = 0;
      let stmLatencyMs = null;
      let mergeLatencyMs = 0;
      let fallbackPasses = 0;
      let semanticStatus = 'NOT_REQUESTED';
      let plannerStatus = plannerEnabled ? 'NOT_NEEDED' : 'DISABLED';
      let plannedSources = [];

      const retrieveSources = async (sources) => {
        const requested = new Set(sources);
        const tasks = [];
        const sourceStartedAt = Date.now();

        if (requested.has('STM')) {
          attemptedSources.add('STM');
          const stmStartedAt = Date.now();
          tasks.push(withSourceTimeout(() => stmAdapter.getRecentContext({
            userId: normalizedUserId,
            sessionId,
            query: text,
            analysis,
            options: { limit: Math.min(normalizedOptions.maxMemories, 8) },
          }), sourceTimeoutMs, 'STM_RETRIEVAL_TIMEOUT', (lateStatus, elapsedMs, errorCode) => {
            console.warn('[MEMORY_SOURCE_LATE_SETTLEMENT]', JSON.stringify({
              traceId,
              source: 'STM',
              status: lateStatus,
              elapsedMs,
              errorCode,
            }));
          }).then((result) => {
            stmMemories = Array.isArray(result?.memories) ? result.memories : [];
            stmLatencyMs = Number(result?.metadata?.latencyMs) || Date.now() - stmStartedAt;
          }).catch((error) => {
            stmLatencyMs = Date.now() - stmStartedAt;
            sourceErrors.stm = error?.code || error?.name || 'STM_INFRASTRUCTURE_FAILURE';
          }));
        }

        const structuredRequested = requested.has('LONG_TERM');
        const semanticRequested = requested.has('SEMANTIC');
        if (structuredRequested || semanticRequested) {
          if (structuredRequested) attemptedSources.add('LONG_TERM');
          if (semanticRequested) attemptedSources.add('SEMANTIC');
          tasks.push(withSourceTimeout(() => retrieverFactory().retrieve({
            userId: normalizedUserId,
            query: text,
            options: {
              limit: normalizedOptions.maxMemories,
              historical: Boolean(normalizedOptions.historical || route.reason.historical),
              includeSuperseded: Boolean(normalizedOptions.includeSuperseded || route.reason.historical),
              includeStructured: structuredRequested,
              includeSemantic: semanticRequested,
              traceId,
            },
          }), sourceTimeoutMs, 'CANONICAL_RETRIEVAL_TIMEOUT', (lateStatus, elapsedMs, errorCode) => {
            console.warn('[MEMORY_SOURCE_LATE_SETTLEMENT]', JSON.stringify({
              traceId,
              source: 'CANONICAL',
              status: lateStatus,
              elapsedMs,
              errorCode,
            }));
          }).then((result) => {
            canonicalResult = result;
            if (semanticRequested) {
              semanticStatus = result?.semantic?.status || 'SEMANTIC_NO_MATCH';
              if (semanticStatus === 'SEMANTIC_INFRASTRUCTURE_FAILURE') {
                sourceErrors.semantic = result.semantic.errorCode || 'SEMANTIC_INFRASTRUCTURE_FAILURE';
              }
            }
            canonicalMemories = [
              ...canonicalMemories,
              ...(Array.isArray(result?.memories) ? result.memories : []),
            ];
          }).catch((error) => {
            sourceErrors.canonical = error?.code || error?.name || 'CANONICAL_RETRIEVAL_FAILURE';
          }));
        }

        await Promise.all(tasks);
        sourceLatencyMs += Date.now() - sourceStartedAt;
      };

      const routeMiss = route.sources.length === 0;
      if (routeMiss && text && plannerEnabled) {
        const plan = await planMemoryQuery(text, { traceId });
        if (plan && Array.isArray(plan.sources)) {
          plannedSources = plan.sources.filter((source) => ['STM', 'LONG_TERM', 'SEMANTIC'].includes(source));
          plannerStatus = 'VALID';
        } else {
          plannerStatus = 'FALLBACK';
        }
      }
      const initialSources = routeMiss && text
        ? [...new Set(['STM', 'LONG_TERM', ...plannedSources])]
        : route.sources;
      await retrieveSources(initialSources);

      const rankResults = () => {
        const mergeStartedAt = Date.now();
        const merged = mergeCandidates(stmMemories, canonicalMemories, text);
        const memories = rankUnifiedCandidates(merged, text, analysis, normalizedOptions.maxMemories);
        mergeLatencyMs += Date.now() - mergeStartedAt;
        return memories;
      };

      let unified = rankResults();
      const allSources = ['STM', 'LONG_TERM', 'SEMANTIC'];
      const fallbackSources = allSources.filter((source) => !attemptedSources.has(source));
      if (!unified.length && fallbackSources.length) {
        fallbackPasses = 1;
        await retrieveSources(fallbackSources);
        unified = rankResults();
      }

      const sourcesUsed = getUsedSources(unified);
      const failures = Object.keys(sourceErrors);
      const retrievalStatus = unified.length
        ? 'MEMORY_FOUND'
        : (!attemptedSources.size
          ? 'NO_ROUTE'
          : (failures.length ? 'SOURCE_ERROR' : 'NO_MATCH'));
      console.info('[MEMORY_RETRIEVAL_STAGE]', JSON.stringify({
        traceId,
        userIdHash: hashIdentifier(normalizedUserId),
        stage: 'sources_and_ranking',
        status: retrievalStatus,
        queryLength: text.length,
        routing: route.route,
        routingReason: route.reason,
        routeMissFallback: routeMiss && Boolean(text),
        plannerStatus,
        plannedSources,
        fallbackPasses,
        sourcesAttempted: [...attemptedSources],
        sourcesUsed,
        sourceFailures: sourceErrors,
        memoryCount: unified.length,
        sourceLatencyMs,
        mergeLatencyMs,
        canonicalLatency: canonicalResult?.latency || null,
        totalLatencyMs: Date.now() - startedAt,
      }));

      if (!unified.length && retrievalStatus === 'SOURCE_ERROR') {
        return {
          ...createFailureResult('MEMORY_SOURCE_FAILURE', 'Memory sources could not be reached.'),
          metadata: {
            status: retrievalStatus,
            routing: route.route,
            routeMissFallback: routeMiss && Boolean(text),
            plannerStatus,
            plannedSources,
            fallbackPasses,
            sourcesAttempted: [...attemptedSources].map((source) => source.toLowerCase()),
            sourceFailures: sourceErrors,
            routingReason: route.reason,
            latency: {
              stmLatencyMs,
              longTermSemanticLatencyMs: canonicalResult?.latency?.totalCanonicalRetrievalLatencyMs || null,
              semanticLatencyMs: canonicalResult?.latency?.semanticLatencyMs || null,
              mergeLatencyMs,
              totalLatencyMs: Date.now() - startedAt,
            },
          },
        };
      }

      if (!unified.length) {
        const empty = createNoMemoryResult(text, analysis, 'none');
        empty.metadata = {
          ...empty.metadata,
          status: retrievalStatus,
          routing: route.route,
          routeMissFallback: routeMiss && Boolean(text),
          plannerStatus,
          plannedSources,
          fallbackPasses,
          sourcesAttempted: [...attemptedSources].map((source) => source.toLowerCase()),
          sourcesUsed,
          routingReason: route.reason,
          sourceFailures: sourceErrors,
          latency: {
            stmLatencyMs,
            longTermSemanticLatencyMs: canonicalResult?.latency?.totalCanonicalRetrievalLatencyMs || null,
            semanticLatencyMs: canonicalResult?.latency?.semanticLatencyMs || null,
            mergeLatencyMs,
            totalLatencyMs: Date.now() - startedAt,
            sourceLatencyMs,
          },
        };
        return empty;
      }

      const context = buildUnifiedContext(unified, normalizedOptions.maxContextLength);
      return {
        ok: true,
        query: text,
        analysis,
        memories: unified,
        context,
        source: sourcesUsed.length > 1 ? 'unified' : (sourcesUsed[0] || 'none'),
        metadata: {
          resultCount: unified.length,
          status: retrievalStatus,
          routeMissFallback: routeMiss && Boolean(text),
          plannerStatus,
          plannedSources,
          fallbackPasses,
          sourcesAttempted: [...attemptedSources].map((source) => source.toLowerCase()),
          sourcesUsed,
          routing: route.route,
          routingReason: route.reason,
          sourceFailures: sourceErrors,
          semanticStatus,
          latency: {
            stmLatencyMs,
            longTermLatencyMs: canonicalResult?.latency?.structuredRetrievalLatencyMs || null,
            semanticLatencyMs: canonicalResult?.latency?.semanticLatencyMs || null,
            embeddingLatencyMs: canonicalResult?.latency?.embeddingLatencyMs || null,
            pineconeQueryLatencyMs: canonicalResult?.latency?.pineconeQueryLatencyMs || null,
            mergeLatencyMs,
            finalRankingLatencyMs: canonicalResult?.latency?.finalRankingLatencyMs || null,
            totalCanonicalLatencyMs: canonicalResult?.latency?.totalCanonicalRetrievalLatencyMs || null,
            totalLatencyMs: Date.now() - startedAt,
          },
          resultSummary: unified.slice(0, 5).map((memory) => safeMemorySummary(memory)).filter(Boolean),
        },
      };
    } catch (error) {
      const code = error && error.code ? String(error.code) : 'MEMORY_RETRIEVAL_FAILURE';
      const message = code === 'INVALID_USER_ID'
        ? 'Invalid userId.'
        : 'Memory retrieval is temporarily unavailable.';
      return createFailureResult(code, message);
    }
  }

  return { retrieveMemoryContext };
}

const defaultAdapter = createMemoryRetrievalAdapter();

module.exports = {
  retrieveMemoryContext: defaultAdapter.retrieveMemoryContext,
  createMemoryRetrievalAdapter,
  mergeCandidates,
  conflictsWithRecentUpdate,
};
