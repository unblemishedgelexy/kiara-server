const { cosineSimilarity } = require('../../utils/vectorMath');

function rankMemories(memories, queryVector = null) {
  return memories
    .map((memory) => {
      const baseScore = (memory.importanceScore || 0.5) * 0.5
        + ((memory.memoryStrength || 1) / 2) * 0.15
        + ((memory.accessCount || 0) / 10) * 0.1
        + (memory.lastAccessed ? 0.25 : 0);
      const similarity = queryVector && Array.isArray(memory.embedding)
        ? cosineSimilarity(memory.embedding, queryVector) * 0.25
        : 0;
      return { ...memory, rankScore: Number((baseScore + similarity).toFixed(4)) };
    })
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, 20);
}

function topRelevant(memories, limit = 10) {
  return memories.slice(0, limit);
}

module.exports = { rankMemories, topRelevant };