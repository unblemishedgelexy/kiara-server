const redisService = require('./redisService');

const ACTIVE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

function buildActiveKey(userId) {
  return `session:active:${userId}`;
}

async function saveActiveSessionMemory(userId, payload = {}) {
  const client = await redisService.getRedisClient();
  const key = buildActiveKey(userId);
  await client.set(key, JSON.stringify(payload), { EX: ACTIVE_TTL_SECONDS });
  return { success: true, key };
}

async function getActiveSessionMemory(userId) {
  const client = await redisService.getRedisClient();
  const key = buildActiveKey(userId);
  const raw = await client.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function listActiveSessions() {
  const client = await redisService.getRedisClient();
  const keys = await client.keys('session:active:*');
  return keys.map((k) => k.replace('session:active:', ''));
}

async function deleteActiveSessionMemory(userId) {
  const client = await redisService.getRedisClient();
  const key = buildActiveKey(userId);
  const result = await client.del(key);
  return result > 0;
}

module.exports = {
  saveActiveSessionMemory,
  getActiveSessionMemory,
  listActiveSessions,
  deleteActiveSessionMemory,
};
