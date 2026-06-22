const { ensureUserId } = require('../../utils/ensureUserId');
const PersonProfile = require('../../models/PersonProfile');
const GoalMemory = require('../../models/GoalMemory');
const ProjectMemory = require('../../models/ProjectMemory');
const IdentityMemory = require('../../models/IdentityMemory');

/**
 * Memory Compression Service (V7)
 * Creates compressed summaries and caches them in Redis.
 * Reduces token usage for bootstrap and context injection.
 */

const redis = require('redis');
let redisClient = null;

async function getRedisClient() {
  if (!redisClient) {
    const redisService = require('../infrastructure/redisService');
    redisClient = await redisService.getRedisClient();
  }
  return redisClient;
}

const CACHE_TTL_HOURS = 24;

async function compressRelationshipSummary(userId) {
  ensureUserId(userId);

  const client = await getRedisClient();
  const cacheKey = `compressed:relationships:${userId}`;

  // Check cache
  const cached = await client.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // Generate summary
  const profiles = await PersonProfile.find({ userId, active: { $ne: false } })
    .select('name relationship mentionCount importanceScore lastMentioned')
    .sort({ lastMentioned: -1 })
    .limit(10)
    .lean();

  const summary = {
    totalPeople: profiles.length,
    recentPeople: profiles.map((p) => ({
      name: p.name,
      relationship: p.relationship,
      importance: p.importanceScore,
      lastMentioned: p.lastMentioned,
    })),
    summary: generateRelationshipSummary(profiles),
  };

  // Cache
  await client.set(
    cacheKey,
    JSON.stringify(summary),
    { EX: CACHE_TTL_HOURS * 3600 }
  );

  return summary;
}

async function compressGoalSummary(userId) {
  ensureUserId(userId);

  const client = await getRedisClient();
  const cacheKey = `compressed:goals:${userId}`;

  const cached = await client.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const goals = await GoalMemory.find({ userId, active: { $ne: false } })
    .select('encryptedMemory importanceScore category lastAccessed')
    .sort({ importanceScore: -1 })
    .limit(5)
    .lean();

  const summary = {
    totalGoals: goals.length,
    activeGoals: goals.length,
    categories: [...new Set(goals.map((g) => g.category))],
    summary: `Has ${goals.length} active goals across ${[...new Set(goals.map((g) => g.category))].length} areas.`,
  };

  await client.set(
    cacheKey,
    JSON.stringify(summary),
    { EX: CACHE_TTL_HOURS * 3600 }
  );

  return summary;
}

async function compressProjectSummary(userId) {
  ensureUserId(userId);

  const client = await getRedisClient();
  const cacheKey = `compressed:projects:${userId}`;

  const cached = await client.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const projects = await ProjectMemory.find({ userId, active: { $ne: false } })
    .select('encryptedMemory importanceScore lastAccessed')
    .sort({ lastAccessed: -1 })
    .limit(5)
    .lean();

  const summary = {
    totalProjects: projects.length,
    activeProjects: projects.length,
    summary: `Currently working on ${projects.length} projects.`,
  };

  await client.set(
    cacheKey,
    JSON.stringify(summary),
    { EX: CACHE_TTL_HOURS * 3600 }
  );

  return summary;
}

async function compressIdentitySummary(userId) {
  ensureUserId(userId);

  const client = await getRedisClient();
  const cacheKey = `compressed:identity:${userId}`;

  const cached = await client.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const identity = await IdentityMemory.findOne({ userId, active: { $ne: false } })
    .select('encryptedMemory metadata')
    .lean();

  const summary = {
    hasIdentity: !!identity,
    summary: identity ? 'User profile and identity information loaded.' : 'No identity information stored.',
  };

  await client.set(
    cacheKey,
    JSON.stringify(summary),
    { EX: CACHE_TTL_HOURS * 3600 }
  );

  return summary;
}

async function invalidateCompressionCache(userId) {
  ensureUserId(userId);

  const client = await getRedisClient();
  const keys = [
    `compressed:relationships:${userId}`,
    `compressed:goals:${userId}`,
    `compressed:projects:${userId}`,
    `compressed:identity:${userId}`,
  ];

  for (const key of keys) {
    await client.del(key);
  }
}

async function buildCompressedContext(userId) {
  ensureUserId(userId);

  const [relationships, goals, projects, identity] = await Promise.all([
    compressRelationshipSummary(userId),
    compressGoalSummary(userId),
    compressProjectSummary(userId),
    compressIdentitySummary(userId),
  ]);

  return {
    userId,
    identity,
    relationships,
    goals,
    projects,
    compressed: true,
    tokenEstimate: estimateTokens({
      identity,
      relationships,
      goals,
      projects,
    }),
  };
}

function generateRelationshipSummary(profiles) {
  if (profiles.length === 0) return 'No relationships recorded.';
  if (profiles.length === 1) return `Knows ${profiles[0].name}.`;
  
  const names = profiles.slice(0, 3).map((p) => p.name).join(', ');
  const remaining = profiles.length > 3 ? ` and ${profiles.length - 3} others` : '';
  return `Knows ${names}${remaining}.`;
}

function compressMemories(memories = [], opts = {}) {
  // Legacy: Simple compression for backward compatibility
  const groups = {};
  for (const m of memories) {
    const cat = m.category || 'other';
    groups[cat] = groups[cat] || [];
    const short = String(m.memory || '').split(/\s+/).slice(0, 8).join(' ');
    groups[cat].push(short.replace(/\n/g, ' '));
  }

  const lines = [];
  for (const [cat, items] of Object.entries(groups)) {
    if (!items.length) continue;
    if (cat === 'relationship') {
      lines.push(`${capitalize(cat)}: ${items.map((i) => i).join(', ')}`);
    } else {
      lines.push(`${capitalize(cat)}: ${items.slice(0, 10).join(', ')}`);
    }
  }

  return lines.join('\n');
}

function estimateTokens(context) {
  // Rough estimation: 1 token ≈ 4 chars
  let totalChars = 0;

  const stringify = (obj) => JSON.stringify(obj || {});
  
  totalChars += stringify(context.identity || {}).length;
  totalChars += stringify(context.relationships || {}).length;
  totalChars += stringify(context.goals || {}).length;
  totalChars += stringify(context.projects || {}).length;

  return Math.ceil(totalChars / 4);
}

function capitalize(s) {
  return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
}

module.exports = {
  compressMemories,
  compressRelationshipSummary,
  compressGoalSummary,
  compressProjectSummary,
  compressIdentitySummary,
  invalidateCompressionCache,
  buildCompressedContext,
  estimateTokens,
  CACHE_TTL_HOURS,
};
