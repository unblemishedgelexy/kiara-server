const MemoryNameIndex = require('../../models/MemoryNameIndex');
const { ensureUserId } = require('../../utils/ensureUserId');

function buildPersonNode(entry) {
  return {
    id: `${entry.personNameLower}`,
    label: entry.personName,
    relationshipType: entry.relationshipType || 'other',
  };
}

async function buildGraph(userId) {
  ensureUserId(userId);
  const entries = await MemoryNameIndex.find({ userId }).lean();
  const nodes = new Map();
  const edges = [];

  for (const entry of entries) {
    if (!entry.personNameLower) continue;
    if (!nodes.has(entry.personNameLower)) {
      nodes.set(entry.personNameLower, buildPersonNode(entry));
    }

    edges.push({
      from: 'user',
      to: entry.personNameLower,
      memoryId: entry.memoryId,
      relationshipType: entry.relationshipType || 'other',
      category: entry.category,
      createdAt: entry.createdAt,
    });
  }

  return {
    root: { id: 'user', label: 'You' },
    nodes: Array.from(nodes.values()),
    edges,
    totalRelationships: edges.length,
    uniquePeople: nodes.size,
  };
}

module.exports = { buildGraph };
