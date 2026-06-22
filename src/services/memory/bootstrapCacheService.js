const redisService = require('../infrastructure/redisService');

const BOOTSTRAP_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const BOOTSTRAP_LATENCY_KEY = 'bootstrap:lastBuildMs';
const BOOTSTRAP_CACHE_HITS_KEY = 'bootstrap:cacheHits';
const BOOTSTRAP_CACHE_MISSES_KEY = 'bootstrap:cacheMisses';

function buildBootstrapKey(userId) {
  return `bootstrap:${userId}`;
}

async function incrementCacheMetric(key) {
  const client = await redisService.getRedisClient();
  await client.incr(key);
}

async function saveBootstrapContext(userId, payload) {
  const client = await redisService.getRedisClient();
  const key = buildBootstrapKey(userId);
  await client.set(key, JSON.stringify(payload), { EX: BOOTSTRAP_TTL_SECONDS });
  if (typeof payload.buildDurationMs === 'number') {
    await client.set(BOOTSTRAP_LATENCY_KEY, String(payload.buildDurationMs), { EX: BOOTSTRAP_TTL_SECONDS });
  }
  return { success: true, key };
}

async function getLastBuildMs() {
  const client = await redisService.getRedisClient();
  const value = await client.get(BOOTSTRAP_LATENCY_KEY);
  return value ? Number(value) : null;
}

async function cacheBootstrapContext(userId, payload) {
  return saveBootstrapContext(userId, payload);
}

async function lastBuildMs() {
  return getLastBuildMs();
}

async function getCacheHits() {
  const client = await redisService.getRedisClient();
  const [hits, misses] = await Promise.all([
    client.get(BOOTSTRAP_CACHE_HITS_KEY),
    client.get(BOOTSTRAP_CACHE_MISSES_KEY),
  ]);
  return {
    hits: Number(hits || '0'),
    misses: Number(misses || '0'),
    total: Number(hits || '0') + Number(misses || '0'),
  };
}

async function getBootstrapContext(userId) {
  const client = await redisService.getRedisClient();
  const key = buildBootstrapKey(userId);
  const raw = await client.get(key);
  if (!raw) {
    await incrementCacheMetric(BOOTSTRAP_CACHE_MISSES_KEY).catch(() => null);
    return null;
  }
  await incrementCacheMetric(BOOTSTRAP_CACHE_HITS_KEY).catch(() => null);
  try { return JSON.parse(raw); } catch { return null; }
}

async function deleteBootstrapContext(userId) {
  const client = await redisService.getRedisClient();
  const key = buildBootstrapKey(userId);
  const result = await client.del(key);
  return result > 0;
}

module.exports = {
  saveBootstrapContext,
  getBootstrapContext,
  getLastBuildMs,
  deleteBootstrapContext,
};