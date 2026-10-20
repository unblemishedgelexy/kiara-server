'use strict';

const {
  hasSpecificCanonicalIdentity,
  normalizeText,
  sameCanonicalIdentity,
} = require('./consolidationPolicy');

function tokenSet(value) {
  return new Set(normalizeText(value).split(' ').filter(Boolean));
}

function similarity(a, b) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (!left.size && !right.size) {
    return 1;
  }
  const union = new Set([...left, ...right]);
  const intersection = [...left].filter((token) => right.has(token));
  return union.size === 0 ? 1 : intersection.length / union.size;
}

function sameCanonicalFields(existingMemory = {}, candidate = {}) {
  const sameType = (existingMemory.type || '').toLowerCase() === (candidate.type || '').toLowerCase();
  if (!sameType) {
    return false;
  }

  if ((existingMemory.type || '').toLowerCase() === 'project' || (candidate.type || '').toLowerCase() === 'project') {
    return normalizeText(existingMemory.content || '') === normalizeText(candidate.content || '');
  }

  const sameSubject = normalizeText(existingMemory.subject || '') === normalizeText(candidate.subject || '');
  const samePredicate = normalizeText(existingMemory.predicate || '') === normalizeText(candidate.predicate || '');
  const sameValue = normalizeText(existingMemory.value || '') === normalizeText(candidate.value || '');

  return sameSubject && samePredicate && sameValue;
}

function detectDuplicate(existingMemory = {}, candidate = {}) {
  if (!existingMemory || !candidate) {
    return false;
  }

  if (existingMemory.id && candidate.id && existingMemory.id === candidate.id) {
    return true;
  }

  if (existingMemory.status && ['SUPERSEDED', 'EXPIRED', 'ARCHIVED'].includes(String(existingMemory.status).toUpperCase())) {
    return false;
  }

  if (sameCanonicalFields(existingMemory, candidate)) {
    return true;
  }

  const sameType = (existingMemory.type || '').toLowerCase() === (candidate.type || '').toLowerCase();
  if (!sameType) {
    return false;
  }

  if (normalizeText(existingMemory.content || '')
    && normalizeText(existingMemory.content || '') === normalizeText(candidate.content || '')) {
    return true;
  }

  if ((existingMemory.type || '').toLowerCase() === 'project' || (candidate.type || '').toLowerCase() === 'project') {
    return false;
  }

  if (sameCanonicalIdentity(existingMemory, candidate)
    || !hasSpecificCanonicalIdentity(existingMemory)
    || !hasSpecificCanonicalIdentity(candidate)) {
    return false;
  }

  const userValueSimilarity = similarity(existingMemory.value || existingMemory.content || '', candidate.value || candidate.content || '');
  const subjectSimilarity = similarity(existingMemory.subject || '', candidate.subject || '');
  const predicateSimilarity = similarity(existingMemory.predicate || '', candidate.predicate || '');
  const contentSimilarity = similarity(existingMemory.content || '', candidate.content || '');

  return subjectSimilarity >= 0.8
    && predicateSimilarity >= 0.8
    && (userValueSimilarity >= 0.75 || contentSimilarity >= 0.82);
}

module.exports = {
  detectDuplicate,
  similarity,
};
