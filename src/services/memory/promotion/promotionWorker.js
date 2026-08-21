'use strict';

const { env } = require('../../../config/env');
const WorkingMemoryRedis = require('../../workingMemory/redisOperations');
const memoryPromotionService = require('./memoryPromotionService');
const logger = require('../utils/memoryLogger');

let promotionInterval = null;

async function _collectUserIds() {
  try {
    const userIds = await WorkingMemoryRedis.getPromotionCandidates(env.promotionWorkerLimit);
    return Array.isArray(userIds) ? userIds.filter(Boolean).slice(0, env.promotionWorkerLimit) : [];
  } catch (err) {
    logger.error('PROMOTION_WORKER_QUEUE_ERROR', err, { mode: 'promotion-worker' });
    return [];
  }
}

async function _runPromotionCycle() {
  if (!env.enablePinecone || !env.enablePromotionWorker) {
    return;
  }

  const startedAt = Date.now();
  let episodesPromoted = 0;
  let semanticMemoriesUpdated = 0;
  let duplicatePromotionsSkipped = 0;
  let embeddingDurationMs = 0;
  let pineconeDurationMs = 0;
  let totalPromotionSize = 0;
  let totalCompressionRatio = 0;
  let promotionMetricCount = 0;

  try {
    const userIds = await _collectUserIds();
    if (!userIds.length) {
      return;
    }

    for (const userId of userIds) {
      try {
        const result = await memoryPromotionService.promoteUserMemory(userId);
        if (result?.keepQueued && result?.nextDueAt) {
          await WorkingMemoryRedis.deferPromotionCandidate(userId, result.nextDueAt);
          continue;
        }

        if (result?.success) {
          if (result.promoted) {
            await WorkingMemoryRedis.recordPromotionSuccess(userId);
          } else {
            await WorkingMemoryRedis.removePromotionCandidate(userId);
          }
          episodesPromoted += result.episodesPromoted || 0;
          semanticMemoriesUpdated += result.semanticMemoriesUpdated || 0;
          duplicatePromotionsSkipped += result.duplicatePromotionsSkipped || 0;
          if (result.metrics) {
            embeddingDurationMs += result.metrics.embeddingDurationMs || 0;
            pineconeDurationMs += result.metrics.pineconeDurationMs || 0;
            totalPromotionSize += result.metrics.averagePromotionSize || 0;
            totalCompressionRatio += result.metrics.compressionRatio || 0;
            promotionMetricCount += 1;
          }
        }
      } catch (err) {
        await WorkingMemoryRedis.recordPromotionFailure(userId, err);
        logger.error('PROMOTION_CYCLE_ERROR', err, { userId, mode: 'promotion-worker' });
      }
    }

    const queueMetrics = await WorkingMemoryRedis.getPromotionQueueMetrics();
    logger.promotionMetrics({
      queuedUsers: queueMetrics.queuedUsers,
      promotionDurationMs: Date.now() - startedAt,
      embeddingDurationMs,
      pineconeDurationMs,
      episodesPromoted,
      semanticMemoriesUpdated,
      duplicatePromotionsSkipped,
      pendingRetries: queueMetrics.pendingRetries,
      averagePromotionSize: promotionMetricCount ? Math.round(totalPromotionSize / promotionMetricCount) : 0,
      compressionRatio: promotionMetricCount ? Number((totalCompressionRatio / promotionMetricCount).toFixed(3)) : 0,
    });
  } catch (err) {
    logger.error('PROMOTION_WORKER_ERROR', err, { mode: 'promotion-worker' });
  }
}

function startPromotionWorker() {
  if (!env.enablePromotionWorker || promotionInterval) {
    return;
  }

  if (!env.enablePinecone) {
    return;
  }

  setImmediate(() => {
    _runPromotionCycle().catch((err) => {
      logger.error('PROMOTION_WORKER_STARTUP_ERROR', err, { mode: 'promotion-worker' });
    });
  });

  promotionInterval = setInterval(() => {
    _runPromotionCycle().catch((err) => {
      logger.error('PROMOTION_WORKER_INTERVAL_ERROR', err, { mode: 'promotion-worker' });
    });
  }, env.promotionWorkerIntervalMs);
}

function stopPromotionWorker() {
  if (promotionInterval) {
    clearInterval(promotionInterval);
    promotionInterval = null;
  }
}

module.exports = {
  startPromotionWorker,
  stopPromotionWorker,
};
