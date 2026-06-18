const memoryRetrievalService = require('./memoryRetrievalService');
const memoryImportanceService = require('./memoryImportanceService');
const { decrypt } = require('../utils/crypto');

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
  const memories = await memoryRetrievalService.retrieveRelevantMemories(userId, query);
  const scored = memories.map((memory) => ({ memory, score: scoreMemory(memory, query) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((item) => item.memory);
}

module.exports = { selectBootstrapMemories, scoreMemory };