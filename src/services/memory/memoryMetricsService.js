const redisService = require('../infrastructure/redisService');
const { ensureUserId } = require('../../utils/ensureUserId');

const RECALL_COUNT_KEY = 'metrics:memoryRecallCount';
const RECALL_TOTAL_KEY = 'metrics:memoryRecallTotalMs';

function buildMetricKey(userId, metric) {
  return `metrics:memory:${ensureUserId(userId)}:${metric}`;
}

async function recordRecallLatency(milliseconds) {
  const client = await redisService.getRedisClient();
  await client.incrBy(RECALL_COUNT_KEY, 1);
  await client.incrByFloat(RECALL_TOTAL_KEY, Number(milliseconds) || 0);
}

async function incrementMetric(userId, metric, amount = 1) {
  const client = await redisService.getRedisClient();
  const key = buildMetricKey(userId, metric);
  return client.incrBy(key, amount);
}

async function getMetric(userId, metric) {
  const client = await redisService.getRedisClient();
  const key = buildMetricKey(userId, metric);
  const value = await client.get(key);
  return Number(value || 0);
}

async function incrementFilteredMemoryCount(userId, amount = 1) {
  return incrementMetric(userId, 'filteredMessagesCount', amount);
}

async function incrementDuplicateMemoryCount(userId, amount = 1) {
  return incrementMetric(userId, 'duplicateMemoryCount', amount);
}

async function getFilteredMemoryCount(userId) {
  return getMetric(userId, 'filteredMessagesCount');
}

async function getDuplicateMemoryCount(userId) {
  return getMetric(userId, 'duplicateMemoryCount');
}

async function getAverageRecallTime() {
  const client = await redisService.getRedisClient();
  const count = Number(await client.get(RECALL_COUNT_KEY) || 0);
  const total = Number(await client.get(RECALL_TOTAL_KEY) || 0);
  if (!count) return null;
  return Number((total / count).toFixed(2));
}

module.exports = {
  recordRecallLatency,
  getAverageRecallTime,
  incrementFilteredMemoryCount,
  incrementDuplicateMemoryCount,
  getFilteredMemoryCount,
  getDuplicateMemoryCount,
};
