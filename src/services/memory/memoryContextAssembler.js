const redisService = require('../infrastructure/redisService');
const memoryRetrievalService = require('./memoryRetrievalService');
const sessionBootstrapService = require('./sessionBootstrapService');
const memoryProfileService = require('./memoryProfileService');
const sessionMemoryService = require('./sessionMemoryService');

function normalizeText(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function uniqueByFingerprint(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = normalizeText(it.memory || it.encryptedMemory || it.content || '');
    if (!key) continue;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

function sortMemories(memories) {
  return memories.sort((a, b) => {
    // importance desc
    const ia = Number(a.importanceScore || 0);
    const ib = Number(b.importanceScore || 0);
    if (ia !== ib) return ib - ia;
    // accessCount desc
    const aa = Number(a.accessCount || 0);
    const ab = Number(b.accessCount || 0);
    if (aa !== ab) return ab - aa;
    // recency desc
    const ra = a.lastAccessed ? new Date(a.lastAccessed).getTime() : 0;
    const rb = b.lastAccessed ? new Date(b.lastAccessed).getTime() : 0;
    return rb - ra;
  });
}

async function assembleMemoryContext(userId, opts = {}) {
  const tokenBudget = opts.tokenBudget || 1200;
  const stmLimit = opts.stmLimit || 50;

  const [profile, bootstrap, activeSession] = await Promise.all([
    memoryProfileService.getMemoryProfile(userId).catch(() => null),
    sessionBootstrapService.buildSessionBootstrapContext(userId).catch(() => null),
    sessionMemoryService.getActiveSessionMemory(userId).catch(() => null),
  ]);

  // STM from Redis across sessions: try active sessionId
  const stm = [];
  try {
    if (activeSession && activeSession.lastSessionId) {
      const items = await redisService.getShortTermMemory(userId, activeSession.lastSessionId).catch(() => []);
      stm.push(...items.slice(-stmLimit).map((i) => ({ category: 'episodic', memory: i.message, role: i.role, timestamp: i.timestamp })));
    }
  } catch (e) {}

  // LTM relevant
  const ltm = await memoryRetrievalService.retrieveRelevantMemories(userId, opts.query || '').catch(() => []);

  // Profile-derived memories
  const profileMemories = [];
  if (profile) {
    if (profile.identitySummary) profileMemories.push({ category: 'identity', memory: profile.identitySummary });
    if (profile.preferenceSummary) profileMemories.push({ category: 'preference', memory: profile.preferenceSummary });
    if (profile.relationshipSummary) profileMemories.push({ category: 'relationship', memory: profile.relationshipSummary });
    if (profile.projectSummary) profileMemories.push({ category: 'project', memory: profile.projectSummary });
    if (profile.goalSummary) profileMemories.push({ category: 'goal', memory: profile.goalSummary });
  }

  const combined = [].concat(stm, ltm, profileMemories, (bootstrap && bootstrap.selectedMemories) ? bootstrap.selectedMemories : []);
  const unique = uniqueByFingerprint(combined);
  const sorted = sortMemories(unique);

  return { memories: sorted.slice(0, 200), profile, bootstrap, activeSession };
}

module.exports = { assembleMemoryContext };
