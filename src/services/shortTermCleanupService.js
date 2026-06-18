const redisService = require('./redisService');
const sessionMemoryService = require('./sessionMemoryService');
const { env } = require('../config/env');

const SHORT_TERM_KEY_PATTERN = 'memory:short:*';
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

function parseShortTermItem(item) {
  try {
    return JSON.parse(item);
  } catch {
    return null;
  }
}

function normalizeShortTermSignature(entry) {
  return `${entry.role || ''}:${String(entry.message || '').trim().toLowerCase()}`;
}

async function cleanupSessionKey(client, key, keepAliveSessionId) {
  const rawEntries = await client.lRange(key, 0, -1);
  const parsed = rawEntries.map(parseShortTermItem).filter(Boolean);

  if (!parsed.length) {
    await client.del(key);
    return { deleted: true, key };
  }

  const lastTimestamp = new Date(parsed[parsed.length - 1].timestamp).getTime();
  const sessionId = key.split(':').slice(3).join(':');
  const isActive = keepAliveSessionId && sessionId === keepAliveSessionId;

  if (!isActive && Date.now() - lastTimestamp > MAX_SESSION_AGE_MS) {
    await client.del(key);
    return { deleted: true, key };
  }

  const unique = [];
  const seen = new Set();
  for (const entry of parsed) {
    const signature = normalizeShortTermSignature(entry);
    if (!seen.has(signature)) {
      seen.add(signature);
      unique.push(entry);
    }
  }

  if (unique.length !== parsed.length) {
    await client.del(key);
    const serialized = unique.map((entry) => JSON.stringify(entry));
    if (serialized.length) {
      await client.rPush(key, serialized);
      await client.expire(key, env.shortTermMemoryTTL);
    }
    return { deduplicated: true, key };
  }

  return { deleted: false, key };
}

async function cleanupUserShortTermMemory(userId) {
  if (!userId) return null;
  const client = await redisService.getRedisClient();
  const activeSession = await sessionMemoryService.getActiveSessionMemory(userId).catch(() => null);
  const keepAliveSessionId = activeSession?.lastSessionId || null;

  const keys = await client.keys(`memory:short:${userId}:*`).catch(() => []);
  const results = [];
  for (const key of keys) {
    if (!keepAliveSessionId && key.endsWith(':')) {
      await client.del(key);
      results.push({ deleted: true, key });
      continue;
    }
    const result = await cleanupSessionKey(client, key, keepAliveSessionId);
    results.push(result);
  }
  return results;
}

async function cleanupAllShortTermMemory() {
  const client = await redisService.getRedisClient();
  const keys = await client.keys(SHORT_TERM_KEY_PATTERN).catch(() => []);
  const results = [];
  for (const key of keys) {
    const userId = key.split(':')[2];
    const activeSession = await sessionMemoryService.getActiveSessionMemory(userId).catch(() => null);
    const keepAliveSessionId = activeSession?.lastSessionId || null;
    const result = await cleanupSessionKey(client, key, keepAliveSessionId);
    results.push(result);
  }
  return results;
}

module.exports = { cleanupUserShortTermMemory, cleanupAllShortTermMemory };
