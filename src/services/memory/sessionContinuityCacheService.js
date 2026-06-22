const redisService = require('../infrastructure/redisService');
const sacredMemoryService = require('./sacredMemoryService');
const relationshipMemoryEngine = require('./relationshipMemoryEngine');
const activeContextService = require('./activeContextService');
const { ensureUserId } = require('../../utils/ensureUserId');

const CACHE_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

function getCacheKey(userId) {
  return `continuity:${userId}`;
}

async function buildContinuityCache(userId) {
  ensureUserId(userId);

  try {
    // Fetch sacred memories (fast, important data)
    const identity = await sacredMemoryService.getSacredMemoriesByCategory(userId, 'identity').catch(() => []);
    const family = await sacredMemoryService.getSacredMemoriesByCategory(userId, 'family').catch(() => []);
    const relationships = await sacredMemoryService.getSacredMemoriesByCategory(userId, 'relationship').catch(() => []);
    const goals = await sacredMemoryService.getSacredMemoriesByCategory(userId, 'goal').catch(() => []);
    const projects = await sacredMemoryService.getSacredMemoriesByCategory(userId, 'project').catch(() => []);

    // Build relationship summary
    const relationshipGraph = await relationshipMemoryEngine.getRelationshipSummary(userId).catch(() => ({}));

    // Create condensed cache
    const cacheData = {
      userId,
      identitySummary: identity.slice(0, 3).map((m) => m.content).join(' | '),
      familySummary: family.slice(0, 3).map((m) => m.content).join(' | '),
      relationshipSummary: relationshipGraph,
      goalsSummary: goals.slice(0, 3).map((m) => m.content),
      projectsSummary: projects.slice(0, 3).map((m) => m.content),
      totalSacredMemories: identity.length + family.length + relationships.length + goals.length + projects.length,
      cacheGeneratedAt: new Date().toISOString(),
    };

    // Store in Redis with TTL
    const client = await redisService.getRedisClient();
    // node-redis v4 uses client.set with options
    await client.set(getCacheKey(userId), JSON.stringify(cacheData), { EX: CACHE_TTL });

    return cacheData;
  } catch (err) {
    console.error('Error building continuity cache:', err);
    throw err;
  }
}

async function getContinuityCache(userId) {
  ensureUserId(userId);

  try {
    const client = await redisService.getRedisClient();
    const cached = await client.get(getCacheKey(userId));

    if (cached) {
      return JSON.parse(cached);
    }
    return null;
  } catch (err) {
    console.error('Error fetching continuity cache:', err);
    return null;
  }
}

async function refreshContinuityCache(userId) {
  ensureUserId(userId);
  return buildContinuityCache(userId);
}

async function invalidateContinuityCache(userId) {
  ensureUserId(userId);

  try {
    const client = await redisService.getRedisClient();
    await client.del(getCacheKey(userId));
  } catch (err) {
    console.error('Error invalidating cache:', err);
  }
}

async function buildSessionStartupContext(userId, sessionId) {
  ensureUserId(userId);
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId is required');
  }

  try {
    // Try to get cached continuity first (should be <50ms)
    let cache = await getContinuityCache(userId);

    // If no cache, build it
    if (!cache) {
      cache = await buildContinuityCache(userId);
    }

    // Get active context
    const activeContext = await activeContextService.getContext(userId, sessionId);

    return {
      userId,
      sessionId,
      cache,
      activeContext,
      startupTime: new Date().toISOString(),
    };
  } catch (err) {
    console.error('Error building session startup context:', err);
    throw err;
  }
}

async function updateContinuityCacheOnMemoryChange(userId) {
  ensureUserId(userId);
  // Mark cache as stale by refreshing it
  return refreshContinuityCache(userId);
}

module.exports = {
  buildContinuityCache,
  getContinuityCache,
  refreshContinuityCache,
  invalidateContinuityCache,
  buildSessionStartupContext,
  updateContinuityCacheOnMemoryChange,
  getCacheKey,
};
