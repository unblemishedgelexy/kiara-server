'use strict';

const { normalizeMemoryType } = require('../domain/MemoryType');

const CONSOLIDATION_POLICY_VERSION = '1.0.0';
const CONSOLIDATION_DECISIONS = Object.freeze([
  'CREATE',
  'DUPLICATE',
  'UPDATE',
  'MERGE',
  'SUPERSEDE',
  'COEXIST',
  'IGNORE',
]);

const GENERIC_SUBJECTS = new Set(['user', 'person', 'people', 'i', 'me', 'myself', 'someone', 'somebody']);
const GENERIC_PREDICATES = new Set(['has', 'have', 'is', 'are', 'was', 'were', 'be']);

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasSpecificCanonicalIdentity(memory = {}) {
  const subject = normalizeText(memory.subject);
  const predicate = normalizeText(memory.predicate);
  return Boolean(
    subject
    && predicate
    && !GENERIC_SUBJECTS.has(subject)
    && !GENERIC_PREDICATES.has(predicate)
  );
}

function makePredicateKey(value) {
  return normalizeText(value).replace(/\s+/g, '_');
}

function isTrivialCandidate(candidate = {}) {
  if (!candidate || typeof candidate !== 'object') {
    return true;
  }
  const content = normalizeText(candidate.content || candidate.value || candidate.subject || '');
  if (!content) {
    return true;
  }
  if (content.length < 6) {
    return true;
  }
  const trivialPatterns = ['hello', 'hi there', 'hey', 'good morning', 'good evening', 'thanks', 'thank you'];
  return trivialPatterns.includes(content);
}

function isExplicitUserCorrection(candidate = {}) {
  return String(candidate?.source?.type || '').toUpperCase() === 'USER_CORRECTION';
}

function isExclusivePreference(memory = {}) {
  const type = normalizeMemoryType(memory.type || '');
  if (type !== 'preference') {
    return false;
  }

  const predicate = makePredicateKey([
    memory.subject,
    memory.predicate,
    memory.value,
    memory.content,
  ].filter(Boolean).join(' '));
  const exclusiveTokens = ['preferred', 'favorite', 'theme', 'language', 'country', 'city', 'music', 'book', 'food'];
  return exclusiveTokens.some((token) => predicate.includes(token));
}

function samePreferenceSlot(existingMemory = {}, candidate = {}) {
  if (normalizeMemoryType(existingMemory.type || '') !== 'preference'
    || normalizeMemoryType(candidate.type || '') !== 'preference') {
    return false;
  }

  const slotKey = (memory) => {
    const subject = normalizeText(memory.subject);
    const predicate = normalizeText(memory.predicate);
    const specificIdentity = [
      subject && !GENERIC_SUBJECTS.has(subject) ? subject : '',
      predicate && !GENERIC_PREDICATES.has(predicate) ? predicate : '',
    ].filter(Boolean);
    if (specificIdentity.length) {
      return `identity:${specificIdentity.join('|')}`;
    }

    const descriptor = normalizeText([memory.value, memory.content].filter(Boolean).join(' '));
    const sharedPreferenceTerms = [
      'theme',
      'language',
      'country',
      'city',
      'music',
      'book',
      'food',
      'framework',
      'editor',
      'styling',
      'font',
      'color',
    ];
    const terms = sharedPreferenceTerms.filter((term) => descriptor.split(' ').includes(term));
    return terms.length ? `terms:${terms.sort().join('|')}` : '';
  };
  const left = slotKey(existingMemory);
  const right = slotKey(candidate);
  if (!left || !right) {
    return false;
  }

  return left === right;
}

function isTemporalCoexistence(existingMemory = {}, candidate = {}) {
  if (!existingMemory || !candidate) {
    return false;
  }

  const existingTemporal = existingMemory.temporal || {};
  const candidateTemporal = candidate.temporal || {};
  if (existingTemporal.validUntil || candidateTemporal.validUntil || existingTemporal.validFrom || candidateTemporal.validFrom) {
    return true;
  }

  return false;
}

function sameCanonicalIdentity(existingMemory = {}, candidate = {}) {
  if (!existingMemory || !candidate) {
    return false;
  }

  const sameType = (existingMemory.type || '').toLowerCase() === (candidate.type || '').toLowerCase();
  if (!sameType
    || !hasSpecificCanonicalIdentity(existingMemory)
    || !hasSpecificCanonicalIdentity(candidate)) {
    return false;
  }

  const sameSubject = normalizeText(existingMemory.subject || '') === normalizeText(candidate.subject || '');
  if (!sameSubject) return false;

  const existingPredicate = normalizeText(existingMemory.predicate || '');
  const candidatePredicate = normalizeText(candidate.predicate || '');
  return existingPredicate === candidatePredicate;
}

function sameProjectIdentity(existingMemory = {}, candidate = {}) {
  if ((existingMemory.type || '').toLowerCase() !== 'project'
    || (candidate.type || '').toLowerCase() !== 'project') {
    return false;
  }

  const existingSubject = normalizeText(existingMemory.subject);
  const candidateSubject = normalizeText(candidate.subject);
  return Boolean(
    existingSubject
    && candidateSubject
    && !GENERIC_SUBJECTS.has(existingSubject)
    && !GENERIC_SUBJECTS.has(candidateSubject)
    && existingSubject === candidateSubject
  );
}

function shouldMergeProject(existingMemory = {}, candidate = {}) {
  return sameProjectIdentity(existingMemory, candidate) && !!(candidate.content || candidate.value);
}

module.exports = {
  CONSOLIDATION_POLICY_VERSION,
  CONSOLIDATION_DECISIONS,
  normalizeText,
  hasSpecificCanonicalIdentity,
  makePredicateKey,
  isTrivialCandidate,
  isExplicitUserCorrection,
  isExclusivePreference,
  samePreferenceSlot,
  isTemporalCoexistence,
  sameCanonicalIdentity,
  shouldMergeProject,
};
