'use strict';

const { Memory } = require('../domain/Memory');
const { CONSOLIDATION_DECISIONS, CONSOLIDATION_POLICY_VERSION } = require('./consolidationPolicy');

const consolidationContract = Object.freeze({
  version: CONSOLIDATION_POLICY_VERSION,
  decisions: [...CONSOLIDATION_DECISIONS],
  buildCandidate(input = {}) {
    return new Memory(input).toJSON();
  },
  validateDecisionResult(result = {}) {
    if (!result || typeof result !== 'object') {
      throw new Error('Consolidation result must be an object.');
    }
    if (!result.decision || !CONSOLIDATION_DECISIONS.includes(result.decision)) {
      throw new Error(`Invalid consolidation decision: ${result.decision}`);
    }
    if (result.candidate && typeof result.candidate !== 'object') {
      throw new Error('Consolidation result.candidate must be an object.');
    }
    return result;
  },
});

module.exports = {
  consolidationContract,
};
