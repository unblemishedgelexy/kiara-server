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
  }
  return score;
}

async function selectBootstrapMemories(userId, limit = 20, query = '') {
  const preferredCategories = ['identity', 'relationship', 'goal', 'project'];

  const categoryMemorySets = await Promise.all(
    preferredCategories.map((category) => memoryRetrievalService.retrieveCategoryMemories(userId, [category]))
  );

  const preferredMemories = categoryMemorySets.flat();
  const uniquePreferred = [];
  const seenIds = new Set();
  for (const memory of preferredMemories) {
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
  const fallbackUnique = fallback.filter((memory) => !seenIds.has(memory.id));
  const scoredFallback = fallbackUnique.map((memory) => ({ memory, score: scoreMemory(memory, query) }));
  scoredFallback.sort((a, b) => b.score - a.score);
  const fallbackSelection = scoredFallback.slice(0, limit - selected.length).map((item) => item.memory);

  return selected.concat(fallbackSelection);
}

module.exports = { selectBootstrapMemories, scoreMemory };