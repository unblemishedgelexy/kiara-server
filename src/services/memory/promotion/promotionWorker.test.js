'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { env } = require('../../../config/env');
const WorkingMemoryRedis = require('../../workingMemory/redisOperations');
const promotionWorker = require('./promotionWorker');

test('checks an empty promotion queue once and then stays idle', async () => {
  const originalPinecone = env.enablePinecone;
  const originalWorker = env.enablePromotionWorker;
  const originalGetCandidates = WorkingMemoryRedis.getPromotionCandidates;
  const originalGetNextDueAt = WorkingMemoryRedis.getNextPromotionDueAt;
  let queueChecks = 0;

  env.enablePinecone = true;
  env.enablePromotionWorker = true;
  WorkingMemoryRedis.getPromotionCandidates = async () => {
    queueChecks += 1;
    return [];
  };
  WorkingMemoryRedis.getNextPromotionDueAt = async () => null;

  try {
    promotionWorker.startPromotionWorker();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(queueChecks, 1);

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(queueChecks, 1);
  } finally {
    promotionWorker.stopPromotionWorker();
    WorkingMemoryRedis.getPromotionCandidates = originalGetCandidates;
    WorkingMemoryRedis.getNextPromotionDueAt = originalGetNextDueAt;
    env.enablePinecone = originalPinecone;
    env.enablePromotionWorker = originalWorker;
  }
});

test('backs off when a promotion queue read fails', async () => {
  const originalPinecone = env.enablePinecone;
  const originalWorker = env.enablePromotionWorker;
  const originalGetCandidates = WorkingMemoryRedis.getPromotionCandidates;
  const originalGetNextDueAt = WorkingMemoryRedis.getNextPromotionDueAt;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let retryDelay;

  env.enablePinecone = true;
  env.enablePromotionWorker = true;
  WorkingMemoryRedis.getPromotionCandidates = async () => {
    throw Object.assign(new Error('queue unavailable'), { code: 'REDIS_UNAVAILABLE' });
  };
  WorkingMemoryRedis.getNextPromotionDueAt = async () => null;
  global.setTimeout = (callback, delay, ...args) => {
    if (delay === 60000) {
      retryDelay = delay;
      return { unref() {} };
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  global.clearTimeout = (timer) => {
    if (timer && typeof timer.unref === 'function') return;
    originalClearTimeout(timer);
  };

  try {
    promotionWorker.startPromotionWorker();
    await new Promise((resolve) => originalSetTimeout(resolve, 40));
    assert.equal(retryDelay, 60000);
  } finally {
    promotionWorker.stopPromotionWorker();
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    WorkingMemoryRedis.getPromotionCandidates = originalGetCandidates;
    WorkingMemoryRedis.getNextPromotionDueAt = originalGetNextDueAt;
    env.enablePinecone = originalPinecone;
    env.enablePromotionWorker = originalWorker;
  }
});
