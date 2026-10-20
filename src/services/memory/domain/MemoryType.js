'use strict';

const MEMORY_TYPES = Object.freeze([
  'identity',
  'preference',
  'goal',
  'project',
  'fact',
  'relationship',
  'habit',
  'decision',
  'event',
  'episode',
]);

function normalizeMemoryType(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const normalized = String(value).trim().toLowerCase();
  return normalized;
}

function isValidMemoryType(value) {
  return MEMORY_TYPES.includes(normalizeMemoryType(value));
}

module.exports = {
  MEMORY_TYPES,
  normalizeMemoryType,
  isValidMemoryType,
};
