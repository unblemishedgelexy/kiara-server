const memoryJobService = require('./memoryJobService');
const sessionMemoryService = require('./sessionMemoryService');
const LongTermMemory = require('../models/LongTermMemory');
const MemoryJob = require('../models/MemoryJob');
const redisService = require('./redisService');
const { performance } = require('perf_hooks');

async function calculateAverageBootstrapSize() {
  try {
    const client = await redisService.getRedisClient();
    const keys = await client.keys('bootstrap:*');
    if (!keys.length) return 0;

    const sizes = await Promise.all(keys.map(async (key) => {
      const value = await client.get(key);
      return value ? Buffer.byteLength(value, 'utf8') : 0;
    }));

    return sizes.reduce((sum, size) => sum + size, 0) / sizes.length;
  } catch {
    return 0;
  }
}

async function calculateAverageMemoryRetrievalTime(userId) {
  const start = performance.now();
  await LongTermMemory.find({ userId }).limit(10).lean();
  const end = performance.now();
  return Math.max(0, end - start);
}

async function calculateCacheHitRate() {
  try {
    const client = await redisService.getRedisClient();
    const hits = await client.get('memory:cacheHits') || '0';
    const misses = await client.get('memory:cacheMisses') || '0';
    const hitCount = Number(hits);
    const missCount = Number(misses);
    const total = hitCount + missCount;
    if (total === 0) return 0;
    return hitCount / total;
  } catch {
    return 0;
  }
}

async function calculateQueueSuccessRate() {
  const [completed, failed] = await Promise.all([
    MemoryJob.countDocuments({ status: 'completed' }),
    MemoryJob.countDocuments({ status: 'failed' }),
  ]);
  const total = completed + failed;
  if (total === 0) return 1;
  return total ? completed / total : 0;
}

async function getMemoryStats(userId) {
  const [identityCount, preferenceCount, relationshipCount, projectCount, goalCount, episodicCount, averageBootstrapSize, cacheHitRate, queueSuccessRate] = await Promise.all([
    LongTermMemory.countDocuments({ category: 'identity' }),
    LongTermMemory.countDocuments({ category: 'preference' }),
    LongTermMemory.countDocuments({ category: 'relationship' }),
    LongTermMemory.countDocuments({ category: 'project' }),
    LongTermMemory.countDocuments({ category: 'goal' }),
    LongTermMemory.countDocuments({ category: { $in: ['fact', 'event', 'episodic'] } }),
    calculateAverageBootstrapSize(),
    calculateCacheHitRate(),
    calculateQueueSuccessRate(),
  ]);

  return {
    identityCount,
    preferenceCount,
    relationshipCount,
    projectCount,
    goalCount,
    episodicCount,
    averageBootstrapSize,
    averageMemoryRetrievalTime: await calculateAverageMemoryRetrievalTime(userId),
    cacheHitRate,
    queueSuccessRate,
  };
}

module.exports = { getMemoryStats };