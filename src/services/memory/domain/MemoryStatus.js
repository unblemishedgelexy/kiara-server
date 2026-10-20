'use strict';

const MEMORY_STATUSES = Object.freeze([
  'NEW',
  'CANDIDATE',
  'ACTIVE',
  'SUPERSEDED',
  'EXPIRED',
  'ARCHIVED',
]);

const MEMORY_STATUS_TRANSITIONS = Object.freeze({
  NEW: ['CANDIDATE', 'ACTIVE'],
  CANDIDATE: ['ACTIVE', 'SUPERSEDED'],
  ACTIVE: ['SUPERSEDED', 'EXPIRED', 'ARCHIVED'],
  SUPERSEDED: ['ACTIVE', 'EXPIRED', 'ARCHIVED'],
  EXPIRED: ['ARCHIVED'],
  ARCHIVED: [],
});

function normalizeMemoryStatus(value) {
  if (value === null || value === undefined) {
    return 'ACTIVE';
  }

  const normalized = String(value).trim().toUpperCase();
  return normalized;
}

function isValidMemoryStatus(value) {
  return MEMORY_STATUSES.includes(normalizeMemoryStatus(value));
}

function canTransition(fromStatus, toStatus) {
  const normalizedFrom = normalizeMemoryStatus(fromStatus);
  const normalizedTo = normalizeMemoryStatus(toStatus);
  const allowed = MEMORY_STATUS_TRANSITIONS[normalizedFrom] || [];
  return allowed.includes(normalizedTo);
}

module.exports = {
  MEMORY_STATUSES,
  MEMORY_STATUS_TRANSITIONS,
  normalizeMemoryStatus,
  isValidMemoryStatus,
  canTransition,
};
