const memoryRetrievalService = require('./memoryRetrievalService');
const memoryImportanceService = require('./memoryImportanceService');
const { decrypt } = require('../../utils/crypto');

function scoreMemory(memory, query = '') {
  let score = memory.importanceScore || 0;
  if (memory.accessCount) score += Math.min(memory.accessCount / 20, 1);
  if (memory.lastAccessed) {
    const ageMs = Date.now() - new Date(memory.lastAccessed).getTime();
    score += Math.max(0, 1 - ageMs / (30 * 24 * 60 * 60 * 1000));
  }
  if (query) {
    const lowerQuery = String(query).toLowerCase();
    const text = `${memory.category} ${memory.tags?.join(' ')} ${memory.memory}`.toLowerCase();
    if (text.includes(lowerQuery)) score += 2;
    const terms = lowerQuery.split(/\s+/).filter(Boolean);
    for (const term of terms) {
      if (term && text.includes(term)) score += 1;
    }
  }
  return score;
}

async function retrievePreferredMemories(userId) {
  if (typeof memoryRetrievalService.retrieveCategoryMemories === 'function') {
    return memoryRetrievalService.retrieveCategoryMemories(userId, ['identity', 'relationship', 'goal', 'project']).catch(() => []);
  }

  const [identity, relationship, goal, project] = await Promise.all([
    memoryRetrievalService.retrieveIdentityMemories(userId).catch(() => []),
    memoryRetrievalService.retrieveRelationshipMemories(userId).catch(() => []),
    memoryRetrievalService.retrieveGoalMemories(userId).catch(() => []),
    memoryRetrievalService.retrieveProjectMemories(userId).catch(() => []),
  ]);
  return [...identity, ...relationship, ...goal, ...project];
}

async function selectBootstrapMemories(userId, limit = 20, query = '') {
  const preferredMemories = await retrievePreferredMemories(userId);
  const uniquePreferred = [];
  const seenIds = new Set();

  for (const memory of preferredMemories) {
    if (!memory || !memory.id) continue;
    if (!seenIds.has(memory.id)) {
      seenIds.add(memory.id);
      uniquePreferred.push(memory);
    }
  }

  const scoredPreferred = uniquePreferred.map((memory) => ({ memory, score: scoreMemory(memory, query) }));
  scoredPreferred.sort((a, b) => b.score - a.score);
  const selected = scoredPreferred.slice(0, limit).map((item) => item.memory);

  if (selected.length >= limit) {
    return selected;
  }

  const fallback = await memoryRetrievalService.retrieveRelevantMemories(userId, query);
  const fallbackUnique = fallback.filter((memory) => memory && memory.id && !seenIds.has(memory.id));
  const scoredFallback = fallbackUnique.map((memory) => ({ memory, score: scoreMemory(memory, query) }));
  scoredFallback.sort((a, b) => b.score - a.score);
  const fallbackSelection = scoredFallback.slice(0, limit - selected.length).map((item) => item.memory);

  return selected.concat(fallbackSelection);
}

module.exports = { selectBootstrapMemories, scoreMemory };