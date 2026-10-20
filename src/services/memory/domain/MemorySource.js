'use strict';

const MEMORY_SOURCE_TYPES = Object.freeze([
  'USER',
  'CONVERSATION',
  'ASSISTANT_INFERENCE',
  'SYSTEM',
  'IMPORTED',
  'USER_CORRECTION',
  'EXTERNAL',
]);

function normalizeMemorySourceType(value) {
  if (value === null || value === undefined) {
    return 'CONVERSATION';
  }

  const normalized = String(value).trim().toUpperCase();
  return normalized;
}

function isValidMemorySourceType(value) {
  return MEMORY_SOURCE_TYPES.includes(normalizeMemorySourceType(value));
}

function normalizeMemorySource(source = {}) {
  if (!source || typeof source !== 'object') {
    return {
      type: 'CONVERSATION',
      reference: null,
      timestamp: new Date().toISOString(),
    };
  }

  const type = isValidMemorySourceType(source.type) ? normalizeMemorySourceType(source.type) : 'CONVERSATION';
  const reference = source.reference !== undefined && source.reference !== null ? String(source.reference) : null;
  const timestamp = source.timestamp || new Date().toISOString();

  return {
    type,
    reference,
    timestamp,
  };
}

module.exports = {
  MEMORY_SOURCE_TYPES,
  normalizeMemorySourceType,
  isValidMemorySourceType,
  normalizeMemorySource,
};
