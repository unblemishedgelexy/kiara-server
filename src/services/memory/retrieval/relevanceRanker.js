'use strict';

const { INTENT_TO_MEMORY_TYPES } = require('./retrievalPolicy');

function normalizeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function matchesIntent(memoryType, intent) {
  const allowed = INTENT_TO_MEMORY_TYPES[intent] || [];
  return allowed.includes(String(memoryType || '').toLowerCase());
}

function getStatusScore(status) {
  const normalized = String(status || '').toUpperCase();
  if (normalized === 'ACTIVE') return 1;
  if (normalized === 'CANDIDATE') return 0.7;
  if (normalized === 'NEW') return 0.5;
  return 0;
}

function getTemporalScore(memory) {
  const temporal = memory?.temporal || {};
  const now = Date.now();

  const validFrom = temporal.validFrom ? new Date(temporal.validFrom).getTime() : null;
  const validUntil = temporal.validUntil ? new Date(temporal.validUntil).getTime() : null;

  if (validFrom && validFrom > now) return 0.2;
  if (validUntil && validUntil < now) return 0.1;
  return 1;
}

function ratioOverlap(source = '', target = '') {
  const left = String(source || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const right = String(target || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!left.length || !right.length) return 0;
  const overlap = left.filter((token) => right.includes(token));
  return overlap.length / Math.max(left.length, right.length);
}

function scoreMemory(memory, analysis) {
  const query = String(analysis.rawQuery || '').toLowerCase();
  const queryKeywords = analysis.keywords || [];
  const queryEntities = analysis.entities || [];

  let total = 0;
  const reasons = [];

  if (matchesIntent(memory.type, analysis.intent)) {
    total += 0.35;
    reasons.push('intent');
  } else {
    total += 0.10;
  }

  if (memory.subject) {
    const subjectOverlap = ratioOverlap(memory.subject, query);
    total += subjectOverlap * 0.2;
    if (subjectOverlap > 0) reasons.push('subject');
  }

  if (memory.predicate || memory.value) {
    const predicateOverlap = ratioOverlap(`${memory.predicate || ''} ${memory.value || ''}`, query);
    total += predicateOverlap * 0.2;
    if (predicateOverlap > 0) reasons.push('predicate');
  }

  if (queryKeywords.length) {
    const keywordMatch = queryKeywords.some((keyword) => {
      const haystack = `${memory.subject || ''} ${memory.value || ''} ${memory.content || ''}`.toLowerCase();
      return haystack.includes(keyword.toLowerCase());
    });
    if (keywordMatch) {
      total += 0.15;
      reasons.push('keyword');
    }
  }

  if (queryEntities.length) {
    const entityMatch = queryEntities.some((entity) => {
      const haystack = `${memory.subject || ''} ${memory.content || ''}`.toLowerCase();
      return haystack.includes(entity.toLowerCase());
    });
    if (entityMatch) {
      total += 0.12;
      reasons.push('entity');
    }
  }

  total += getStatusScore(memory.status) * 0.10;
  total += getTemporalScore(memory) * 0.10;
  total += clamp(normalizeNumber(memory.importance?.value, memory.importance || 0), 0, 1) * 0.10;
  total += clamp(normalizeNumber(memory.confidence?.value, memory.confidence || 0), 0, 1) * 0.08;
  const semanticScore = clamp(normalizeNumber(memory.semanticScore, 0), 0, 1);
  if (semanticScore > 0) {
    total += semanticScore * 0.12;
    reasons.push('semantic');
  }

  if (memory.source?.type === 'USER_CORRECTION') total += 0.05;
  if (memory.lifecycle?.updatedAt) {
    const ageMs = Date.now() - new Date(memory.lifecycle.updatedAt).getTime();
    const recency = clamp(1 - ageMs / (1000 * 60 * 60 * 24 * 365), 0, 1);
    total += recency * 0.10;
  }

  total = clamp(total, 0, 1);

  return {
    score: Number(total.toFixed(4)),
    reasons,
  };
}

function rankMemories(memories = [], analysis = {}) {
  if (!Array.isArray(memories) || memories.length === 0) {
    return [];
  }

  return memories
    .map((memory) => ({
      ...memory,
      retrievalScore: scoreMemory(memory, analysis),
    }))
    .sort((left, right) => (right.retrievalScore.score || 0) - (left.retrievalScore.score || 0))
    .map((memory) => ({
      ...memory,
      score: memory.retrievalScore.score,
      reasons: memory.retrievalScore.reasons,
    }));
}

module.exports = {
  rankMemories,
  scoreMemory,
};
