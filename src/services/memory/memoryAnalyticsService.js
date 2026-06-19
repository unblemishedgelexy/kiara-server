const memoryJobService = require('./memoryJobService');
const sessionMemoryService = require('./sessionMemoryService');
const LongTermMemory = require('../../models/LongTermMemory');
const MemoryJob = require('../../models/MemoryJob');
const redisService = require('../infrastructure/redisService');
const memoryMetricsService = require('./memoryMetricsService');
const { ensureUserId } = require('../../utils/ensureUserId');
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
  const safeUserId = ensureUserId(userId);
  const start = performance.now();
  await LongTermMemory.find({ userId: safeUserId }).limit(10).lean();
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
  const safeUserId = ensureUserId(userId);
  const [identityCount, preferenceCount, relationshipCount, projectCount, goalCount, episodicCount, averageBootstrapSize, cacheHitRate, queueSuccessRate, filteredMessagesCount, duplicateMemoryCount] = await Promise.all([
    LongTermMemory.countDocuments({ userId: safeUserId, category: 'identity' }),
    LongTermMemory.countDocuments({ userId: safeUserId, category: 'preference' }),
    LongTermMemory.countDocuments({ userId: safeUserId, category: 'relationship' }),
    LongTermMemory.countDocuments({ userId: safeUserId, category: 'project' }),
    LongTermMemory.countDocuments({ userId: safeUserId, category: 'goal' }),
    LongTermMemory.countDocuments({ userId: safeUserId, category: { $in: ['fact', 'event', 'episodic'] } }),
    calculateAverageBootstrapSize(),
    calculateCacheHitRate(),
    calculateQueueSuccessRate(),
    memoryMetricsService.getFilteredMemoryCount(safeUserId),
    memoryMetricsService.getDuplicateMemoryCount(safeUserId),
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
    filteredMessagesCount,
    duplicateMemoryCount,
  };
}

module.exports = { getMemoryStats };