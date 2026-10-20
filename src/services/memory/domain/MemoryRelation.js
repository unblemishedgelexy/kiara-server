'use strict';

const MEMORY_RELATION_TYPES = Object.freeze([
  'RELATED_TO',
  'BELONGS_TO',
  'HAS_GOAL',
  'HAS_PREFERENCE',
  'WORKS_ON',
  'DEPENDS_ON',
  'DERIVED_FROM',
  'SUPERSEDES',
  'CONTRADICTS',
]);

function clamp01(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, numeric));
}

function normalizeMemoryRelation(relation) {
  if (!relation || typeof relation !== 'object') {
    throw new Error('Memory relation must be an object.');
  }

  const type = String(relation.type || '').trim().toUpperCase();
  if (!MEMORY_RELATION_TYPES.includes(type)) {
    throw new Error(`Invalid memory relation type: ${relation.type}`);
  }

  const targetMemoryId = String(relation.targetMemoryId || relation.target || '').trim();
  if (!targetMemoryId) {
    throw new Error('Memory relation targetMemoryId is required.');
  }

  return {
    type,
    targetMemoryId,
    confidence: clamp01(relation.confidence ?? 0.5),
    metadata: relation.metadata || {},
  };
}

module.exports = {
  MEMORY_RELATION_TYPES,
  normalizeMemoryRelation,
};
