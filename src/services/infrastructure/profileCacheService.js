const redisService = require('./redisService');

const PROFILE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function buildProfileKey(userId) {
  return `profile:${userId}`;
}

async function saveProfileCache(userId, payload) {
  const client = await redisService.getRedisClient();
  const key = buildProfileKey(userId);
  await client.set(key, JSON.stringify(payload), { EX: PROFILE_TTL_SECONDS });
  return { success: true, key };
}

async function getProfileCache(userId) {
  const client = await redisService.getRedisClient();
  const key = buildProfileKey(userId);
  const raw = await client.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function deleteProfileCache(userId) {
  const client = await redisService.getRedisClient();
  const key = buildProfileKey(userId);
  const result = await client.del(key);
  return result > 0;
}

module.exports = {
  saveProfileCache,
  getProfileCache,
  deleteProfileCache,
};