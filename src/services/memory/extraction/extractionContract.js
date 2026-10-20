'use strict';

const VALID_DECISIONS = Object.freeze([
  'MEMORY',
  'NO_MEMORY',
  'UPDATE',
  'SUPERSEDE',
  'IGNORE',
  'ERROR',
]);

function assertDecision(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!VALID_DECISIONS.includes(normalized)) {
    throw new Error(`Unsupported extraction decision: ${value}`);
  }
  return normalized;
}

module.exports = {
  VALID_DECISIONS,
  assertDecision,
};
