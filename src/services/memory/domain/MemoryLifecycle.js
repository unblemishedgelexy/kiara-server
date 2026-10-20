'use strict';

const MEMORY_LIFECYCLE_STATES = Object.freeze([
  'NEW',
  'CANDIDATE',
  'ACTIVE',
  'SUPERSEDED',
  'EXPIRED',
  'ARCHIVED',
]);

function normalizeLifecycleEntry(lifecycle = {}) {
  const createdAt = lifecycle.createdAt || new Date().toISOString();
  const updatedAt = lifecycle.updatedAt || createdAt;
  const lastAccessedAt = lifecycle.lastAccessedAt || null;
  const lastConfirmedAt = lifecycle.lastConfirmedAt || null;

  return {
    createdAt,
    updatedAt,
    lastAccessedAt,
    lastConfirmedAt,
  };
}

module.exports = {
  MEMORY_LIFECYCLE_STATES,
  normalizeLifecycleEntry,
};
