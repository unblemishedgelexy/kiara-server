'use strict';

const { MemoryConsolidator } = require('./memoryConsolidator');
const { consolidationContract } = require('./consolidationContract');
const { resolveConflict } = require('./conflictResolver');
const { detectDuplicate } = require('./duplicateDetector');
const {
  CONSOLIDATION_DECISIONS,
  CONSOLIDATION_POLICY_VERSION,
  isExplicitUserCorrection,
  isExclusivePreference,
  isTrivialCandidate,
} = require('./consolidationPolicy');

module.exports = {
  MemoryConsolidator,
  resolveConflict,
  detectDuplicate,
  consolidationContract,
  CONSOLIDATION_DECISIONS,
  CONSOLIDATION_POLICY_VERSION,
  isExplicitUserCorrection,
  isExclusivePreference,
  isTrivialCandidate,
};
