'use strict';

const { Memory } = require('../domain/Memory');
const { detectDuplicate } = require('./duplicateDetector');
const {
  isTrivialCandidate,
  isExplicitUserCorrection,
  isExclusivePreference,
  samePreferenceSlot,
  isTemporalCoexistence,
  sameCanonicalIdentity,
  shouldMergeProject,
} = require('./consolidationPolicy');

function normalizeDecisionResult(base, overrides = {}) {
  return {
    ...base,
    ...overrides,
    changes: overrides.changes || base.changes || {},
  };
}

function isStalePreferenceVersion(existingMemory, candidate) {
  if (!existingMemory || String(existingMemory.type || '').toLowerCase() !== 'preference'
    || String(candidate?.type || '').toLowerCase() !== 'preference'
    || !samePreferenceSlot(existingMemory, candidate)
    || String(existingMemory.value || '').trim().toLowerCase() === String(candidate?.value || '').trim().toLowerCase()) {
    return false;
  }

  const existingTimestamp = new Date(
    existingMemory.source?.timestamp || existingMemory.lifecycle?.updatedAt || 0
  ).getTime();
  const candidateTimestamp = new Date(
    candidate.source?.timestamp || candidate.lifecycle?.createdAt || 0
  ).getTime();
  return Number.isFinite(existingTimestamp)
    && Number.isFinite(candidateTimestamp)
    && existingTimestamp > 0
    && candidateTimestamp > 0
    && candidateTimestamp < existingTimestamp;
}

function resolveConflict({ candidate, existingMemory }) {
  if (!candidate) {
    return normalizeDecisionResult({ decision: 'IGNORE', reason: 'No candidate supplied.' });
  }

  if (isTrivialCandidate(candidate)) {
    return normalizeDecisionResult({ decision: 'IGNORE', reason: 'Candidate is too trivial to persist.' });
  }

  if (isStalePreferenceVersion(existingMemory, candidate)) {
    return normalizeDecisionResult({
      decision: 'DUPLICATE',
      candidate,
      existingMemory,
      reason: 'An older preference version cannot replace a newer canonical value.',
      changes: { action: 'none', affectedMemoryId: existingMemory.id },
    });
  }

  if (existingMemory && detectDuplicate(existingMemory, candidate)) {
    return normalizeDecisionResult({
      decision: 'DUPLICATE',
      candidate,
      existingMemory,
      reason: 'Candidate matches an existing active memory.',
      changes: { action: 'none', affectedMemoryId: existingMemory.id },
    });
  }

  if (!existingMemory) {
    return normalizeDecisionResult({
      decision: 'CREATE',
      candidate,
      existingMemory: null,
      reason: 'No relevant active memory exists for this user.',
      changes: { action: 'create' },
    });
  }

  if (isExplicitUserCorrection(candidate) && isExclusivePreference(existingMemory) && isExclusivePreference(candidate)) {
    return normalizeDecisionResult({
      decision: 'SUPERSEDE',
      candidate,
      existingMemory,
      reason: 'Explicit user correction overrides an exclusive preference.',
      changes: { action: 'supersede', oldMemoryId: existingMemory.id },
    });
  }

  if (isTemporalCoexistence(existingMemory, candidate)) {
    return normalizeDecisionResult({
      decision: 'COEXIST',
      candidate,
      existingMemory,
      reason: 'Temporal context suggests historical/current information should coexist.',
      changes: { action: 'create', affectedMemoryId: existingMemory.id },
    });
  }

  if (shouldMergeProject(existingMemory, candidate)) {
    return normalizeDecisionResult({
      decision: 'MERGE',
      candidate,
      existingMemory,
      reason: 'Project enrichment should extend the existing project memory without destructive overwrite.',
      changes: { action: 'merge', memoryId: existingMemory.id },
    });
  }

  if (sameCanonicalIdentity(existingMemory, candidate)) {
    return normalizeDecisionResult({
      decision: 'SUPERSEDE',
      candidate,
      existingMemory,
      reason: 'The same identified fact has a new value; preserve the prior value as superseded.',
      changes: { action: 'supersede', oldMemoryId: existingMemory.id },
    });
  }

  if (String(existingMemory.type || '').toLowerCase() === 'preference' && String(candidate.type || '').toLowerCase() === 'preference') {
    if (samePreferenceSlot(existingMemory, candidate)) {
      return normalizeDecisionResult({
        decision: 'SUPERSEDE',
        candidate,
        existingMemory,
        reason: 'Same preference slot with new user preference; supersede the stale value.',
        changes: { action: 'supersede', oldMemoryId: existingMemory.id },
      });
    }
  }

  return normalizeDecisionResult({
    decision: 'CREATE',
    candidate,
    existingMemory,
    reason: 'Candidate adds distinct non-duplicate information.',
    changes: { action: 'create' },
  });
}

module.exports = {
  resolveConflict,
  isStalePreferenceVersion,
};
