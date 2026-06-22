const redisService = require('../infrastructure/redisService');
const { ensureUserId } = require('../../utils/ensureUserId');

async function recordMetric(metricName, value, userId = null) {
  try {
    const client = await redisService.getRedisClient();
    const key = userId ? `metrics:${userId}:${metricName}` : `metrics:${metricName}`;

    // Record metric value
    await client.lpush(key, JSON.stringify({ value, timestamp: Date.now() }));
    // Keep only last 1000 values
    await client.ltrim(key, 0, 999);
    // Expire old metrics after 30 days
    await client.expire(key, 30 * 24 * 60 * 60);
  } catch (err) {
    console.error('Error recording metric:', err);
  }
}

async function recordRecallAccuracy(userId, accuracy) {
  ensureUserId(userId);
  await recordMetric('recall_accuracy', accuracy, userId);
}

async function recordContinuityScore(userId, score) {
  ensureUserId(userId);
  await recordMetric('continuity_score', score, userId);
}

async function recordMemoryRetrievalLatency(userId, latencyMs) {
  ensureUserId(userId);
  await recordMetric('retrieval_latency', latencyMs, userId);
}

async function recordPromptTokenUsage(userId, tokens) {
  ensureUserId(userId);
  await recordMetric('prompt_tokens', tokens, userId);
}

async function recordRelationshipRecallAccuracy(userId, accuracy) {
  ensureUserId(userId);
  await recordMetric('relationship_recall_accuracy', accuracy, userId);
}

async function getMetricsStats(userId, metricName, limit = 100) {
  ensureUserId(userId);

  try {
    const client = await redisService.getRedisClient();
    const key = `metrics:${userId}:${metricName}`;
    const values = await client.lrange(key, 0, limit - 1);

    if (!values.length) return null;

    const parsed = values.map((v) => {
      try {
        return JSON.parse(v);
      } catch {
        return null;
      }
    }).filter(Boolean);

    if (!parsed.length) return null;

    const nums = parsed.map((p) => p.value);
    const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
    const min = Math.min(...nums);
    const max = Math.max(...nums);

    return {
      metricName,
      average: avg.toFixed(2),
      min,
      max,
      sampleCount: nums.length,
      lastValue: nums[0],
    };
  } catch (err) {
    console.error('Error getting metrics stats:', err);
    return null;
  }
}

async function getMemoryV6Health() {
  return {
    status: 'operational',
    services: {
      sacredMemory: 'active',
      relationshipEngine: 'active',
      activeContext: 'active',
      recallEngine: 'active',
      continuityCache: 'active',
      personProfiles: 'active',
      followUpMemory: 'active',
    },
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  recordMetric,
  recordRecallAccuracy,
  recordContinuityScore,
  recordMemoryRetrievalLatency,
  recordPromptTokenUsage,
  recordRelationshipRecallAccuracy,
  getMetricsStats,
  getMemoryV6Health,
};
