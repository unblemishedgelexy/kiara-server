const redisService = require('./redisService');

const RECALL_COUNT_KEY = 'metrics:memoryRecallCount';
const RECALL_TOTAL_KEY = 'metrics:memoryRecallTotalMs';

async function recordRecallLatency(milliseconds) {
  const client = await redisService.getRedisClient();
  await client.incrBy(RECALL_COUNT_KEY, 1);
  await client.incrByFloat(RECALL_TOTAL_KEY, Number(milliseconds) || 0);
}

async function getAverageRecallTime() {
  const client = await redisService.getRedisClient();
  const count = Number(await client.get(RECALL_COUNT_KEY) || 0);
  const total = Number(await client.get(RECALL_TOTAL_KEY) || 0);
  if (!count) return null;
  return Number((total / count).toFixed(2));
}

module.exports = { recordRecallLatency, getAverageRecallTime };
