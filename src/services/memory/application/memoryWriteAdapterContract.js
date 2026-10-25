'use strict';

const WRITE_STATUSES = Object.freeze([
  'INVALID_INPUT',
  'NO_MEMORY',
  'VALIDATION_REJECTION',
  'NO_OP',
  'DRY_RUN',
  'EXTRACTION_FAILURE',
  'CONSOLIDATION_FAILURE',
  'MONGO_FAILURE',
  'CACHE_FAILURE',
  'SEMANTIC_INDEX_FAILURE',
  'DUPLICATE',
  'PARTIAL_SUCCESS',
  'SUCCESS',
]);

const INFRASTRUCTURE_FAILURES = new Set([
  'EXTRACTION_FAILURE',
  'CONSOLIDATION_FAILURE',
  'MONGO_FAILURE',
]);

function createWriteResult(status, details = {}) {
  return {
    ok: status === 'SUCCESS'
      || status === 'NO_MEMORY'
      || status === 'VALIDATION_REJECTION'
      || status === 'NO_OP'
      || status === 'DRY_RUN'
      || status === 'DUPLICATE'
      || status === 'PARTIAL_SUCCESS'
      || status === 'CACHE_FAILURE'
      || status === 'SEMANTIC_INDEX_FAILURE',
    status,
    saved: false,
    memories: [],
    warnings: [],
    metadata: {},
    ...details,
  };
}

module.exports = {
  WRITE_STATUSES,
  INFRASTRUCTURE_FAILURES,
  createWriteResult,
};
