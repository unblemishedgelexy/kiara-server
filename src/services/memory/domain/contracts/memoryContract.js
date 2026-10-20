'use strict';

const { Memory } = require('../Memory');
const { MEMORY_TYPES } = require('../MemoryType');
const { MEMORY_STATUSES } = require('../MemoryStatus');
const { MEMORY_SOURCE_TYPES } = require('../MemorySource');
const { MEMORY_RELATION_TYPES } = require('../MemoryRelation');

function normalizeMemoryDocument(input = {}) {
  return Memory.normalize(input);
}

function assertValidMemoryDocument(input = {}) {
  const memory = normalizeMemoryDocument(input);
  Memory.assertValidMemory(memory);
  return memory;
}

const memoryContract = Object.freeze({
  allowedTypes: [...MEMORY_TYPES],
  allowedStatuses: [...MEMORY_STATUSES],
  allowedSourceTypes: [...MEMORY_SOURCE_TYPES],
  allowedRelationTypes: [...MEMORY_RELATION_TYPES],
  normalizeMemoryDocument,
  assertValidMemoryDocument,
});

module.exports = {
  memoryContract,
  normalizeMemoryDocument,
  assertValidMemoryDocument,
};
