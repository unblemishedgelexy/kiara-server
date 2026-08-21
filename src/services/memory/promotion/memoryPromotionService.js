'use strict';

const { env } = require('../../../config/env');
const WorkingMemoryRedis = require('../../workingMemory/redisOperations');
const pineconeService = require('../../pineconeService');
const { analyzeConversation, buildEpisode } = require('./memoryAnalyzer');
const { computeEmbedding } = require('../../../utils/memory/memoryUtils');
const logger = require('../utils/memoryLogger');

const PROMOTION_VERSION = '1';
const MIN_PROMOTION_INTERVAL_MS = 15 * 60 * 1000;

function buildEpisodeMetadata(userId, episode) {
  return {
    userId,
    memoryId: episode.id,
    memoryType: 'episode',
    createdAt: episode.startTime,
    updatedAt: episode.endTime,
    importance: 0.6,
    entities: episode.entities,
    topics: episode.topics,
    emotion: episode.emotion,
    summary: episode.summary,
    timelineStart: episode.startTime,
    timelineEnd: episode.endTime,
    embeddingVersion: '1',
    promotionVersion: PROMOTION_VERSION,
    source: 'memory-promotion',
  };
}

function timestampIdPart(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? String(timestamp) : String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function userIdPart(userId) {
  return String(userId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildEpisodeId(userId, startTime, endTime) {
  return `episode:${userIdPart(userId)}:${timestampIdPart(startTime)}:${timestampIdPart(endTime)}`;
}

function characterCount(value) {
  return String(value || '').length;
}

function promotionWindowTurns(turns, lastPromotion) {
  if (!lastPromotion) {
    return turns;
  }

  return turns.filter((turn) => {
    const timestamp = Date.parse(String(turn.timestamp || ''));
    return Number.isFinite(timestamp) && timestamp > lastPromotion;
  });
}

async function promoteUserMemory(userId) {
  if (!userId) {
    throw new Error('Missing userId for memory promotion');
  }

  const promotionStartedAt = Date.now();
  logger.promotionStart({ userId, status: 'starting', startTime: promotionStartedAt });
  const promotionState = await WorkingMemoryRedis.getPromotionState(userId);
  const lastPromotion = promotionState?.lastPromotion || 0;
  if (lastPromotion && Date.now() - lastPromotion < MIN_PROMOTION_INTERVAL_MS) {
    return {
      success: true,
      promoted: false,
      keepQueued: true,
      reason: 'promotion_not_due',
      nextDueAt: lastPromotion + MIN_PROMOTION_INTERVAL_MS,
    };
  }

  const turns = await WorkingMemoryRedis.getRecentMemory(userId);
  if (!turns || turns.length === 0) {
    logger.promotionQueueStatus({ userId, reason: 'no_recent_turns', status: 'skipped' });
    return { success: true, promoted: false, reason: 'no_recent_turns' };
  }

  const promotableTurns = promotionWindowTurns(turns, lastPromotion);
  if (!promotableTurns.length) {
    return { success: true, promoted: false, reason: 'no_new_turns' };
  }

  const rawConversationSize = characterCount(JSON.stringify(promotableTurns));
  const analysisStartedAt = Date.now();
  const analysis = await analyzeConversation(promotableTurns, userId);
  const analysisDurationMs = Date.now() - analysisStartedAt;
  logger.memoryAnalyzer({ userId, rule: 'episode_extraction', turnCount: promotableTurns.length, factCount: (analysis.facts || []).length, topicCount: (analysis.topics || []).length, durationMs: analysisDurationMs });
  const episode = buildEpisode(promotableTurns, analysis);
  const episodeId = buildEpisodeId(userId, episode.startTime, episode.endTime);
  const episodeMemory = {
    id: episodeId,
    namespace: 'episodes',
    text: episode.text,
    embeddingText: episode.embeddingText,
    metadata: buildEpisodeMetadata(userId, { ...episode, id: episodeId }),
  };

  if (await WorkingMemoryRedis.alreadyPromotedEpisode(userId, episodeId)) {
    return {
      success: true,
      promoted: false,
      duplicatePromotionsSkipped: 1,
      reason: 'already_promoted',
    };
  }

  const semanticStartedAt = Date.now();
  const semanticMemoriesUpdated = await WorkingMemoryRedis.upsertSemanticMemories(userId, analysis.semanticMemories);
  const semanticDurationMs = Date.now() - semanticStartedAt;

  await pineconeService.ensureIndex();

  if (!episodeMemory.embeddingText || !episodeMemory.id) {
    return { success: true, promoted: false, reason: 'empty_episode' };
  }

  const embeddingStartedAt = Date.now();
  logger.embeddingStart({ userId, episodeId, textLength: String(episodeMemory.embeddingText || '').length });
  const embedding = await computeEmbedding(episodeMemory.embeddingText);
  const embeddingDurationMs = Date.now() - embeddingStartedAt;
  logger.embeddingResult({ userId, episodeId, durationMs: embeddingDurationMs, vectorLength: Array.isArray(embedding) ? embedding.length : 0, success: Boolean(embedding && Array.isArray(embedding)) });

  if (!embedding || !Array.isArray(embedding)) {
    throw new Error('Embedding generation failed for episode promotion');
  }

  const pineconeStartedAt = Date.now();

  // Log upsert intent with metadata and vector dimension
  logger.pineconeVerify({ status: 'upsert_intent', id: episodeMemory.id, namespace: episodeMemory.namespace, metadata: episodeMemory.metadata, vectorLength: Array.isArray(embedding) ? embedding.length : 0, host: env.pineconeHost || null });

  const pineconeOk = await pineconeService.upsertLongTermVector({
    id: episodeMemory.id,
    vector: embedding,
    metadata: episodeMemory.metadata,
    namespace: episodeMemory.namespace,
  });
  const pineconeDurationMs = Date.now() - pineconeStartedAt;
  logger.pineconeUpsert({ userId, episodeId, durationMs: pineconeDurationMs, success: Boolean(pineconeOk) });

  if (!pineconeOk) {
    throw new Error('Pinecone upsert failed for episode promotion');
  }

  // Initialize memory stats (importance/confidence) and temporal markers
  const baseImportance = (() => {
    let v = 0.6;
    if (episode.emotion === 'sensitive') v += 0.15;
    if (episode.emotion === 'positive') v += 0.05;
    if (analysis.decisions && analysis.decisions.length) v += 0.12;
    if (analysis.topics && analysis.topics.length) v += Math.min(0.08 * analysis.topics.length, 0.2);
    return Math.min(0.98, Number(v.toFixed(3)));
  })();

  const avgFactConfidence = (analysis.facts && analysis.facts.length) ? (analysis.facts.reduce((s, f) => s + (Number(f.confidenceScore || 0)), 0) / analysis.facts.length) : 0.6;

  // set initial memory stats in Redis for reinforcement
  try {
    await WorkingMemoryRedis.setMemoryStats(episodeMemory.id, {
      importance: baseImportance,
      confidence: Number(avgFactConfidence.toFixed(3)),
      accessFrequency: 0,
      retrievalPriority: baseImportance,
      createdAt: episode.startTime,
      memoryType: 'episode',
    });
  } catch (e) {
    logger.logError('MEMORY_STATS_INIT_ERROR', e, { userId, episodeId });
  }

  // Update relationships automatically from entities and relationship facts
  try {
    const people = Array.isArray(analysis.entities) ? analysis.entities : [];
    // also include explicit relationship facts
    for (const fact of (analysis.facts || [])) {
      if (fact.category === 'relationships' && fact.value) {
        people.push(fact.value);
      }
    }
    const uniquePeople = Array.from(new Set(people)).slice(0, 64);
    for (const person of uniquePeople) {
      const relObj = {
        relationshipType: 'unknown',
        importance: baseImportance,
        confidence: Number(avgFactConfidence.toFixed(3)),
        sharedEvents: [episodeId],
        projects: analysis.topics || [],
        boost: 0.06,
      };
      await WorkingMemoryRedis.upsertRelationship(userId, person, relObj);
      logger.log('RELATIONSHIP_UPDATED', { userId, person, episodeId, importance: relObj.importance });
    }
  } catch (e) {
    logger.logError('RELATIONSHIP_AUTO_UPDATE_ERROR', e, { userId, episodeId });
  }

  await WorkingMemoryRedis.markEpisodePromoted(userId, episodeId);

  const compressedEpisodeSize = characterCount(episodeMemory.embeddingText);
  const compressionRatio = rawConversationSize > 0
    ? Number((compressedEpisodeSize / rawConversationSize).toFixed(3))
    : 0;
  logger.promotionComplete({ userId, episodeId, durationMs: Date.now() - promotionStartedAt, promotableTurns: promotableTurns.length, compressionRatio, embeddingDurationMs, pineconeDurationMs });

  const metrics = {
    queuedUsers: 0,
    promotionDurationMs: Date.now() - promotionStartedAt,
    embeddingDurationMs,
    pineconeDurationMs,
    episodesPromoted: 1,
    semanticMemoriesUpdated,
    duplicatePromotionsSkipped: 0,
    pendingRetries: 0,
    averagePromotionSize: compressedEpisodeSize,
    compressionRatio,
    semanticDurationMs,
    turnCount: promotableTurns.length,
  };

  logger.promotionMetrics({ userId, ...metrics });

  return {
    success: true,
    promoted: true,
    promotedCount: 1,
    episodesPromoted: 1,
    semanticMemoriesUpdated,
    duplicatePromotionsSkipped: 0,
    metrics,
  };
}

module.exports = {
  promoteUserMemory,
};
