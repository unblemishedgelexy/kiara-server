'use strict';

const { env } = require('../../../config/env');
const WorkingMemoryRedis = require('../../workingMemory/redisOperations');
const memoryPromotionService = require('./memoryPromotionService');
const { isWipeInProgress } = require('../deletion/userMemoryWipeService');

let promotionInterval = null;

async function _collectUserIds() {
  try {
    const userIds = await WorkingMemoryRedis.getPromotionCandidates(env.promotionWorkerLimit);
    return Array.isArray(userIds) ? userIds.filter(Boolean).slice(0, env.promotionWorkerLimit) : [];
  } catch (err) {
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

    const redisService = require('../../infrastructure/redisService');

    for (const userId of userIds) {
      try {
        if (await isWipeInProgress(userId)) {
          continue;
        }

        // GUARD: Check if user's working memory still exists (prevent promotion after wipe)
        const client = await redisService.getRedisClient();
        if (client) {
          const workingKey = WorkingMemoryRedis.buildKey(userId);
          const exists = await client.exists(workingKey);

          if (!exists) {
            // User was wiped; remove from queue and skip promotion
            await WorkingMemoryRedis.removePromotionCandidate(userId);
            continue;
          }
        }

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
      }
    }

    const queueMetrics = await WorkingMemoryRedis.getPromotionQueueMetrics();
  } catch (err) {
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
    });
  });

  promotionInterval = setInterval(() => {
    _runPromotionCycle().catch((err) => {
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
