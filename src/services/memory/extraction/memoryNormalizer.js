'use strict';

const { v4: uuidv4 } = require('uuid');
const { Memory } = require('../domain/Memory');
const { normalizeMemoryType, estimateImportance, estimateConfidence } = require('./memoryClassifier');

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeSignal(value, fallbackLabel = 'MEDIUM') {
  const numeric = Number(value);
  const safeValue = Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0.5;
  const label = ['HIGH', 'MEDIUM', 'LOW'].includes(String(fallbackLabel || '').trim().toUpperCase())
    ? String(fallbackLabel).trim().toUpperCase()
    : (safeValue >= 0.8 ? 'HIGH' : safeValue >= 0.45 ? 'MEDIUM' : 'LOW');

  return {
    value: safeValue,
    label,
  };
}

function buildTemporalFromText(text) {
  const value = normalizeText(text);
  if (!value) {
    return {};
  }

  const lower = value.toLowerCase();
  if (/\b(?:today|current(?:ly)?|now)\b/.test(lower)) {
    return { validFrom: new Date().toISOString() };
  }

  if (/\b(?:tomorrow|next week|next month|next year|later)\b/.test(lower)) {
    return { validFrom: new Date().toISOString() };
  }

  if (/\b(?:used to|previously|before|used to like|used to prefer)\b/.test(lower)) {
    return { validUntil: new Date().toISOString() };
  }

  return {};
}

function normalizeCandidate(rawCandidate = {}, context = {}) {
  const safeContext = context || {};
  const rawType = rawCandidate.type || rawCandidate.category || rawCandidate.memoryType || 'fact';
  const memoryType = normalizeMemoryType(rawType);
  if (!memoryType) {
    throw new Error(`Unsupported or unknown memory type: ${rawType}`);
  }

  const userId = normalizeText(safeContext.userId || rawCandidate.userId);
  if (!userId) {
    throw new Error('Extraction requires a userId.');
  }

  const subject = normalizeText(rawCandidate.subject || safeContext.subject || 'user');
  const predicate = normalizeText(rawCandidate.predicate || rawCandidate.action || 'has');
  const value = normalizeText(rawCandidate.value || rawCandidate.attribute || rawCandidate.data || '');
  const content = normalizeText(rawCandidate.content || `${subject} ${predicate} ${value}`.trim() || rawCandidate.summary || safeContext.userMessage || '');

  if (!content) {
    throw new Error('Memory candidate content is empty.');
  }

  const sourceType = normalizeText(rawCandidate.source?.type || safeContext.sourceType || (safeContext.sourceRole === 'assistant' ? 'ASSISTANT_INFERENCE' : 'USER'));
  const sourceObject = {
    type: sourceType.toUpperCase(),
    reference: normalizeText(rawCandidate.source?.reference || safeContext.reference || safeContext.sessionId || ''),
    timestamp: rawCandidate.source?.timestamp || new Date().toISOString(),
  };

  const explicitness = rawCandidate.explicitness || safeContext.explicitness || 'medium';
  const confidenceValue = Number(rawCandidate.confidence?.value ?? rawCandidate.confidence ?? estimateConfidence(memoryType, explicitness));
  const importanceValue = Number(rawCandidate.importance?.value ?? (rawCandidate.importance === 'HIGH' ? 0.9 : rawCandidate.importance === 'LOW' ? 0.2 : 0.6));

  const normalizedMemory = {
    id: rawCandidate.id || `mem_${uuidv4()}`,
    userId,
    type: memoryType,
    subject: subject || 'user',
    predicate: predicate || 'has',
    value: value || content,
    content,
    source: sourceObject,
    confidence: normalizeSignal(confidenceValue, rawCandidate.confidence?.label || 'MEDIUM'),
    importance: normalizeSignal(importanceValue, rawCandidate.importance?.label || estimateImportance(memoryType)),
    status: 'CANDIDATE',
    temporal: {
      ...buildTemporalFromText(rawCandidate.temporal?.validFrom || rawCandidate.temporal || ''),
      lastConfirmedAt: new Date().toISOString(),
    },
    lifecycle: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastAccessedAt: null,
      lastConfirmedAt: new Date().toISOString(),
    },
    relations: Array.isArray(rawCandidate.relations) ? rawCandidate.relations : [],
    provenance: {
      sourceRole: safeContext.sourceRole || 'user',
      sourceText: safeContext.userMessage || safeContext.assistantMessage || '',
      explicitness,
      extractor: 'memoryExtractor',
    },
    version: 1,
    metadata: rawCandidate.metadata || {},
  };

  return new Memory(normalizedMemory).toJSON();
}

module.exports = {
  normalizeText,
  buildTemporalFromText,
  normalizeCandidate,
};
