const redisService = require('../infrastructure/redisService');

const BOOTSTRAP_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function buildBootstrapKey(userId) {
  return `bootstrap:${userId}`;
}

async function saveBootstrapContext(userId, payload) {
  const client = await redisService.getRedisClient();
  const key = buildBootstrapKey(userId);
  await client.set(key, JSON.stringify(payload), { EX: BOOTSTRAP_TTL_SECONDS });
  return { success: true, key };
}

async function cacheBootstrapContext(userId, payload) {
  return saveBootstrapContext(userId, payload);
}

async function lastBuildMs() {
  // placeholder: not tracked currently
  return null;
}

async function getCacheHits() {
  return null;
}

async function getBootstrapContext(userId) {
  const client = await redisService.getRedisClient();
  const key = buildBootstrapKey(userId);
  const raw = await client.get(key);
  if (!raw) return null;
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
  deleteBootstrapContext,
};