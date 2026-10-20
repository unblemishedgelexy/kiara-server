'use strict';

const crypto = require('node:crypto');
const { analyzeQuery } = require('./queryAnalyzer');
const { rankMemories } = require('./relevanceRanker');
const { validateRetrievalResult } = require('./retrievalContract');
const { shouldIncludeHistory, INTENT_TO_MEMORY_TYPES } = require('./retrievalPolicy');
const { MongoMemoryRepository } = require('../repository/mongoMemoryRepository');
const { RedisMemoryCache } = require('../cache/redisMemoryCache');
const { MemoryNotFoundError } = require('../repository/errors');
const { semanticIndex } = require('../semantic/semanticIndex');
const { embedQuery } = require('../semantic/semanticEmbedding');

const ACTIVE_STATUSES = new Set(['ACTIVE', 'CANDIDATE']);
const HISTORICAL_STATUSES = new Set(['ACTIVE', 'CANDIDATE', 'SUPERSEDED']);
const INACTIVE_STATUSES = new Set(['SUPERSEDED', 'EXPIRED', 'ARCHIVED']);

function logRetrievalStage({ traceId, userId, stage, status, elapsedMs, ...details }) {
  console.info('[MEMORY_RETRIEVAL_DETAIL]', JSON.stringify({
    traceId: traceId || 'untraced',
    userIdHash: crypto.createHash('sha256').update(String(userId || '')).digest('hex').slice(0, 12),
    stage,
    status,
    elapsedMs,
    ...details,
  }));
}

function queryMatchesMemory(memory, query, analysis = {}) {
  if (!query || !String(query).trim()) return true;

  const intentTypes = INTENT_TO_MEMORY_TYPES[analysis.intent];
  if (
    analysis.intent !== 'GENERAL_MEMORY'
    && Array.isArray(intentTypes)
    && intentTypes.includes(String(memory.type || '').toLowerCase())
  ) {
    return true;
  }

  const text = String(query || '').toLowerCase();
  const terms = [...(analysis.keywords || []), ...(analysis.entities || [])]
    .map((term) => String(term || '').toLowerCase().trim())
    .filter(Boolean);
  const haystack = `${memory.subject || ''} ${memory.predicate || ''} ${memory.value || ''} ${memory.content || ''}`.toLowerCase();

  if (haystack.includes(text)) return true;
  return terms.some((term) => haystack.includes(term));
}

function isTemporallyValid(memory, historical) {
  const temporal = memory.temporal || {};
  const now = Date.now();
  const validFrom = temporal.validFrom ? new Date(temporal.validFrom).getTime() : null;
  const validUntil = temporal.validUntil ? new Date(temporal.validUntil).getTime() : null;

  if (validFrom !== null && (!Number.isFinite(validFrom) || validFrom > now)) return false;
  if (validUntil !== null && (!Number.isFinite(validUntil) || (!historical && validUntil <= now))) return false;
  return true;
}

function isEligibleLifecycle(memory, { historical = false, includeSuperseded = false } = {}) {
  const status = String(memory.status || '').toUpperCase();
  if (INACTIVE_STATUSES.has(status)) {
    return historical && includeSuperseded && status === 'SUPERSEDED';
  }
  return (historical ? HISTORICAL_STATUSES : ACTIVE_STATUSES).has(status);
}

function canonicalMemoryId(memory) {
  return String(memory && memory.id || '').trim();
}

class MemoryRetriever {
  constructor({
    repository = null,
    cache = null,
    semantic = null,
    embedQueryFn = null,
  } = {}) {
    this.repository = repository || new MongoMemoryRepository();
    this.cache = cache || new RedisMemoryCache();
    this.semantic = semantic || semanticIndex;
    this.embedQuery = embedQueryFn || embedQuery;
  }

  async _readFromCache(userId, traceId) {
    const startedAt = Date.now();
    if (!this.cache || typeof this.cache.getByUser !== 'function') {
      logRetrievalStage({ traceId, userId, stage: 'redis_cache_lookup', status: 'SKIPPED', elapsedMs: 0, resultCount: 0 });
      return [];
    }
    try {
      const results = await this.cache.getByUser(userId);
      const memories = Array.isArray(results)
        ? results.filter((memory) => String(memory.userId || '') === String(userId))
        : [];
      logRetrievalStage({
        traceId,
        userId,
        stage: 'redis_cache_lookup',
        status: 'SUCCESS',
        elapsedMs: Date.now() - startedAt,
        resultCount: memories.length,
      });
      return memories;
    } catch (error) {
      logRetrievalStage({
        traceId,
        userId,
        stage: 'redis_cache_lookup',
        status: 'FAILURE',
        elapsedMs: Date.now() - startedAt,
        errorCode: error?.code || error?.name || 'REDIS_CACHE_READ_FAILURE',
        resultCount: 0,
      });
      return [];
    }
  }

  async _readFromRepository(userId, options = {}, traceId) {
    const startedAt = Date.now();
    if (!this.repository) return [];
    const queryOptions = { limit: 100, sort: { updatedAt: -1 } };
    try {
      let memories = [];
      let operation = 'find_active_by_user';
      if (options.historical && typeof this.repository.findByUser === 'function') {
        operation = 'find_by_user';
        memories = await this.repository.findByUser(userId, queryOptions);
      } else if (typeof this.repository.findActiveByUser === 'function') {
        memories = await this.repository.findActiveByUser(userId, queryOptions);
      }
      logRetrievalStage({
        traceId,
        userId,
        stage: 'mongo_repository_read',
        operation,
        status: 'SUCCESS',
        elapsedMs: Date.now() - startedAt,
        resultCount: memories.length,
        limit: queryOptions.limit,
      });
      return memories;
    } catch (error) {
      logRetrievalStage({
        traceId,
        userId,
        stage: 'mongo_repository_read',
        status: 'FAILURE',
        elapsedMs: Date.now() - startedAt,
        errorCode: error?.code || error?.name || 'MONGO_REPOSITORY_READ_FAILURE',
      });
      throw error;
    }
  }

  async _getMongoMemory(userId, memoryId) {
    if (!this.repository || typeof this.repository.getById !== 'function') return null;
    try {
      return await this.repository.getById(userId, memoryId);
    } catch (error) {
      if (error instanceof MemoryNotFoundError || error?.name === 'MemoryNotFoundError') {
        return null;
      }
      throw error;
    }
  }

  async _getMongoMemories(userId, memoryIds) {
    const uniqueIds = [...new Set(memoryIds.map((id) => String(id || '').trim()).filter(Boolean))];
    if (!uniqueIds.length) return [];
    if (typeof this.repository?.getManyByIds === 'function') {
      return this.repository.getManyByIds(userId, uniqueIds);
    }
    return Promise.all(uniqueIds.map((id) => this._getMongoMemory(userId, id)));
  }

  async _validateStructuredCandidates(userId, candidates, filterOptions, traceId) {
    const startedAt = Date.now();
    const uniqueIds = [...new Set(candidates.map(canonicalMemoryId).filter(Boolean))];
    try {
      const authoritative = await this._getMongoMemories(userId, uniqueIds);
      const byId = new Map(authoritative.filter(Boolean).map((memory) => [canonicalMemoryId(memory), memory]));
      const validated = uniqueIds
        .map((id) => byId.get(id))
        .filter((memory) => memory
          && String(memory.userId) === String(userId)
          && isEligibleLifecycle(memory, filterOptions)
          && isTemporallyValid(memory, filterOptions.historical));
      logRetrievalStage({
        traceId,
        userId,
        stage: 'mongo_authoritative_validation',
        status: 'SUCCESS',
        elapsedMs: Date.now() - startedAt,
        candidateCount: uniqueIds.length,
        validatedCount: validated.length,
      });
      return validated;
    } catch (error) {
      logRetrievalStage({
        traceId,
        userId,
        stage: 'mongo_authoritative_validation',
        status: 'FAILURE',
        elapsedMs: Date.now() - startedAt,
        candidateCount: uniqueIds.length,
        errorCode: error?.code || error?.name || 'MONGO_VALIDATION_FAILURE',
      });
      throw error;
    }
  }

  async _readSemanticCandidates(userId, query, options, latency) {
    const startedAt = Date.now();
    const traceId = options.traceId;
    const timings = { embeddingLatencyMs: 0, pineconeQueryLatencyMs: 0, semanticStatus: 'SEMANTIC_NO_MATCH' };
    const finish = (memories) => {
      latency.embeddingLatencyMs = timings.embeddingLatencyMs;
      latency.pineconeQueryLatencyMs = timings.pineconeQueryLatencyMs;
      latency.semanticLatencyMs = Date.now() - startedAt;
      logRetrievalStage({
        traceId,
        userId,
        stage: 'semantic_retrieval',
        status: timings.semanticStatus,
        elapsedMs: latency.semanticLatencyMs,
        embeddingLatencyMs: timings.embeddingLatencyMs,
        pineconeQueryLatencyMs: timings.pineconeQueryLatencyMs,
        resultCount: memories.length,
        errorCode: timings.semanticErrorCode || null,
      });
      return { memories, timings };
    };
    if (!this.semantic || typeof this.semantic.query !== 'function' || !String(query || '').trim()) {
      return finish([]);
    }

    try {
      const embedded = await this.embedQuery(query);
      const vector = Array.isArray(embedded) ? embedded : embedded.embedding;
      timings.embeddingLatencyMs = Number(embedded?.latencyMs) || 0;
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new Error('Query embedding was empty.');
      }

      const queryStartedAt = Date.now();
      const response = await this.semantic.query(userId, vector, {
        topK: Math.min(Math.max(Number(options.semanticTopK) || 20, 1), 50),
        includeSuperseded: Boolean(options.historical && options.includeSuperseded),
        types: options.types,
        type: options.type,
      });
      timings.pineconeQueryLatencyMs = Date.now() - queryStartedAt;
      if (response?.status === 'SEMANTIC_INFRASTRUCTURE_FAILURE') {
        throw new Error('Semantic index infrastructure failure.');
      }
      if (response?.status === 'SEMANTIC_NO_MATCH' || !Array.isArray(response?.matches) || response.matches.length === 0) {
        timings.semanticStatus = 'SEMANTIC_NO_MATCH';
        return finish([]);
      }

      const matches = response.matches.filter((match) => (
        String(match.userId || '') === String(userId)
        && match.memoryId
        && Number.isFinite(Number(match.score))
      ));
      const authoritativeById = new Map(
        (await this._getMongoMemories(userId, matches.map((match) => match.memoryId)))
          .map((memory) => [canonicalMemoryId(memory), memory]),
      );
      const resolved = matches.map((match) => {
        const memory = authoritativeById.get(String(match.memoryId).trim());
        if (!memory || String(memory.userId) !== String(userId)) return null;
        if (!isEligibleLifecycle(memory, {
          historical: Boolean(options.historical),
          includeSuperseded: Boolean(options.historical && options.includeSuperseded),
        })) return null;
        if (!isTemporallyValid(memory, Boolean(options.historical))) return null;
        if (Number(match.version) !== Number(memory.version)) return null;

        return {
          ...(typeof memory.toJSON === 'function' ? memory.toJSON() : memory),
          semanticScore: Math.max(0, Math.min(1, Number(match.score))),
        };
      });
      timings.semanticStatus = resolved.some(Boolean) ? 'OK' : 'SEMANTIC_NO_MATCH';
      return finish(resolved.filter(Boolean));
    } catch (error) {
      timings.semanticStatus = 'SEMANTIC_INFRASTRUCTURE_FAILURE';
      timings.semanticErrorCode = error?.code || error?.name || 'SEMANTIC_INFRASTRUCTURE_FAILURE';
      return finish([]);
    }
  }

  async retrieve({ userId, query, options = {} } = {}) {
    const totalStartedAt = Date.now();
    if (!String(userId || '').trim()) {
      throw new Error('userId is required for retrieval.');
    }

    const safeUserId = String(userId).trim();
    const queryText = String(query || '').trim();
    const analysis = analyzeQuery(queryText);
    const historical = Boolean(options.historical || shouldIncludeHistory(queryText));
    const includeSuperseded = Boolean(options.includeSuperseded || historical);
    const filterOptions = { historical, includeSuperseded };
    const latency = {};

    const includeStructured = options.includeStructured !== false;
    const includeSemantic = options.includeSemantic !== false;
    let activeCached = [];
    let structuredCandidates = [];
    let source = 'none';
    if (includeStructured) {
      const structuredStartedAt = Date.now();
      const cached = await this._readFromCache(safeUserId, options.traceId);
      activeCached = cached.filter((memory) => (
        isEligibleLifecycle(memory, filterOptions)
        && isTemporallyValid(memory, historical)
        && queryMatchesMemory(memory, queryText, analysis)
      ));

      if (activeCached.length) {
        structuredCandidates = await this._validateStructuredCandidates(
          safeUserId,
          activeCached,
          filterOptions,
          options.traceId,
        );
        if (structuredCandidates.length) {
          source = 'cache';
        } else {
          activeCached = [];
        }
      }

      if (!activeCached.length) {
        structuredCandidates = await this._readFromRepository(safeUserId, { historical }, options.traceId);
        structuredCandidates = structuredCandidates.filter((memory) => (
          isEligibleLifecycle(memory, filterOptions)
          && isTemporallyValid(memory, historical)
          && queryMatchesMemory(memory, queryText, analysis)
        ));
        source = 'repository';
      }
      latency.structuredRetrievalLatencyMs = Date.now() - structuredStartedAt;
    } else {
      latency.structuredRetrievalLatencyMs = 0;
    }

    const semanticResult = includeSemantic
      ? await this._readSemanticCandidates(
          safeUserId,
          queryText,
          {
            ...options,
            historical,
            includeSuperseded,
            types: options.types || (analysis.intent !== 'GENERAL_MEMORY' ? INTENT_TO_MEMORY_TYPES[analysis.intent] : null),
          },
          latency,
        )
      : {
          memories: [],
          timings: { semanticStatus: 'NOT_REQUESTED', semanticErrorCode: null },
        };

    const mergeStartedAt = Date.now();
    const merged = new Map();
    for (const memory of [...structuredCandidates, ...semanticResult.memories]) {
      const id = canonicalMemoryId(memory);
      if (!id || String(memory.userId) !== safeUserId) continue;
      const current = merged.get(id);
      if (!current || Number(memory.version || 0) >= Number(current.version || 0)) {
        merged.set(id, memory);
      }
    }
    latency.candidateMergeLatencyMs = Date.now() - mergeStartedAt;

    const validationStartedAt = Date.now();
    const authoritative = await this._validateStructuredCandidates(
      safeUserId,
      [...merged.values()],
      filterOptions,
      options.traceId,
    );
    latency.mongoValidationLatencyMs = Date.now() - validationStartedAt;
    const semanticScores = new Map(semanticResult.memories.map((memory) => [
      canonicalMemoryId(memory),
      Number(memory.semanticScore) || 0,
    ]));
    const validated = authoritative.map((memory) => ({
      ...(typeof memory.toJSON === 'function' ? memory.toJSON() : memory),
      ...(semanticScores.has(canonicalMemoryId(memory))
        ? { semanticScore: semanticScores.get(canonicalMemoryId(memory)) }
        : {}),
    }));

    const rankingStartedAt = Date.now();
    const limit = Math.min(Math.max(Number(options.limit) || 8, 1), 20);
    const ranked = rankMemories(validated, analysis).slice(0, limit);
    latency.finalRankingLatencyMs = Date.now() - rankingStartedAt;
    latency.totalCanonicalRetrievalLatencyMs = Date.now() - totalStartedAt;

    const sources = new Set([
      ...(activeCached.length ? ['cache'] : []),
      ...(structuredCandidates.length && !activeCached.length ? ['repository'] : []),
      ...(semanticResult.memories.length ? ['semantic'] : []),
    ]);
    if (!sources.size && semanticResult.timings.semanticStatus === 'SEMANTIC_INFRASTRUCTURE_FAILURE') {
      sources.add('repository');
    }
    source = ranked.length
      ? (sources.size > 1 ? 'mixed' : (sources.values().next().value || 'none'))
      : 'none';

    return validateRetrievalResult({
      analysis,
      memories: ranked,
      source,
      semantic: {
        status: semanticResult.timings.semanticStatus,
        errorCode: semanticResult.timings.semanticErrorCode || null,
      },
      sourcesUsed: [
        ...(activeCached.length ? ['LONG_TERM_CACHE'] : []),
        ...(structuredCandidates.length && !activeCached.length ? ['LONG_TERM_MONGO'] : []),
        ...(semanticResult.memories.length ? ['SEMANTIC'] : []),
      ],
      latency,
    });
  }
}

module.exports = {
  MemoryRetriever,
};
