'use strict';

const { Memory } = require('./Memory');
const { MEMORY_TYPES } = require('./MemoryType');
const { MEMORY_STATUSES, canTransition } = require('./MemoryStatus');
const { MEMORY_SOURCE_TYPES, normalizeMemorySource } = require('./MemorySource');
const { MEMORY_RELATION_TYPES, normalizeMemoryRelation } = require('./MemoryRelation');
const { MEMORY_LIFECYCLE_STATES } = require('./MemoryLifecycle');
const { memoryContract, normalizeMemoryDocument, assertValidMemoryDocument } = require('./contracts/memoryContract');

module.exports = {
  Memory,
  MEMORY_TYPES,
  MEMORY_STATUSES,
  MEMORY_SOURCE_TYPES,
  MEMORY_RELATION_TYPES,
  MEMORY_LIFECYCLE_STATES,
  canTransition,
  normalizeMemorySource,
  normalizeMemoryRelation,
  memoryContract,
  normalizeMemoryDocument,
  assertValidMemoryDocument,
};
