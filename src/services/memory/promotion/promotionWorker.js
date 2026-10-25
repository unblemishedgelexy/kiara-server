'use strict';

const { env } = require('../../../config/env');
const WorkingMemoryRedis = require('../../workingMemory/redisOperations');
const memoryPromotionService = require('./memoryPromotionService');
const { isWipeInProgress } = require('../deletion/userMemoryWipeService');
const promotionQueueEvents = require('./promotionQueueEvents');

const REDIS_RETRY_DELAY_MS = 60000;
let promotionTimer = null;
let runningCycle = null;
let rerunRequested = false;
let workerStarted = false;

async function _collectUserIds() {
  const userIds = await WorkingMemoryRedis.getPromotionCandidates(env.promotionWorkerLimit);
  return Array.isArray(userIds) ? userIds.filter(Boolean).slice(0, env.promotionWorkerLimit) : [];
}

async function _runPromotionCycle() {
  if (!env.enablePinecone || !env.enablePromotionWorker) {
    return;
  }

  const userIds = await _collectUserIds();
  if (!userIds.length) return;

  const redisService = require('../../infrastructure/redisService');

  for (const userId of userIds) {
    try {
      if (await isWipeInProgress(userId)) {
        continue;
      }

      const client = await redisService.getRedisClient();
      if (client) {
        const workingKey = WorkingMemoryRedis.buildKey(userId);
        const exists = await client.exists(workingKey);

        if (!exists) {
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
      }
    } catch (err) {
      await WorkingMemoryRedis.recordPromotionFailure(userId, err);
    }
  }
}

function _schedule(delayMs) {
  if (!workerStarted || promotionTimer) return;
  promotionTimer = setTimeout(() => {
    promotionTimer = null;
    if (runningCycle) {
      rerunRequested = true;
      return;
    }
    let cycleFailed = false;
    runningCycle = _runPromotionCycle()
      .catch((error) => {
        cycleFailed = true;
        rerunRequested = false;
        console.error('[MEMORY_PROMOTION_WORKER]', JSON.stringify({
          status: 'FAILURE',
          errorCode: error?.code || error?.name || 'PROMOTION_CYCLE_FAILURE',
        }));
      })
      .finally(() => {
        runningCycle = null;
        if (cycleFailed) {
          _schedule(REDIS_RETRY_DELAY_MS);
        } else if (rerunRequested) {
          rerunRequested = false;
          _schedule(0);
        } else {
          _scheduleNextDue();
        }
      });
  }, Math.max(0, delayMs));
  promotionTimer.unref?.();
}

async function _scheduleNextDue() {
  if (!workerStarted || promotionTimer) return;
  try {
    const dueAt = await WorkingMemoryRedis.getNextPromotionDueAt();
    if (dueAt !== null) _schedule(Math.max(0, dueAt - Date.now()));
  } catch (error) {
    console.error('[MEMORY_PROMOTION_WORKER]', JSON.stringify({
      status: 'QUEUE_READ_FAILURE',
      errorCode: error?.code || error?.name || 'PROMOTION_QUEUE_READ_FAILURE',
      retryDelayMs: REDIS_RETRY_DELAY_MS,
    }));
    _schedule(REDIS_RETRY_DELAY_MS);
  }
}

function _onWorkAvailable() {
  if (runningCycle) {
    rerunRequested = true;
    return;
  }
  if (promotionTimer) {
    clearTimeout(promotionTimer);
    promotionTimer = null;
  }
  _schedule(0);
}

function startPromotionWorker() {
  if (!env.enablePromotionWorker || workerStarted) {
    return;
  }

  if (!env.enablePinecone) {
    return;
  }

  workerStarted = true;
  promotionQueueEvents.on('work-available', _onWorkAvailable);
  _schedule(0);
}

function stopPromotionWorker() {
  workerStarted = false;
  promotionQueueEvents.off('work-available', _onWorkAvailable);
  if (promotionTimer) clearTimeout(promotionTimer);
  promotionTimer = null;
  rerunRequested = false;
}

module.exports = {
  startPromotionWorker,
  stopPromotionWorker,
};
