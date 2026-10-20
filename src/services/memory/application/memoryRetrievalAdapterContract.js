'use strict';

const crypto = require('crypto');

function normalizeOptions(input = {}) {
  const options = input && typeof input === 'object' ? input : {};
  const maxMemories = Number.isFinite(Number(options.maxMemories)) ? Number(options.maxMemories) : 6;
  const maxContextLength = Number.isFinite(Number(options.maxContextLength)) ? Number(options.maxContextLength) : 1800;

  return {
    current: Boolean(options.current),
    historical: Boolean(options.historical),
    recent: Boolean(options.recent),
    includeSuperseded: Boolean(options.includeSuperseded),
    semanticOnly: Boolean(options.semanticOnly),
    maxMemories: Math.min(Math.max(maxMemories, 1), 20),
    maxContextLength: Math.min(Math.max(maxContextLength, 300), 8000),
  };
}

function validateUserId(userId) {
  const normalized = String(userId || '').trim();
  if (!normalized) {
    throw Object.assign(new Error('Invalid userId.'), { code: 'INVALID_USER_ID' });
  }
  return normalized;
}

function createNoMemoryResult(query = '', analysis = null, source = 'none') {
  return {
    ok: true,
    query: String(query || ''),
    analysis: analysis || { intent: 'GENERAL_MEMORY', keywords: [], entities: [], temporalHints: [] },
    memories: [],
    context: '',
    source,
    metadata: {
      resultCount: 0,
      filters: { current: false, historical: false, recent: false, includeSuperseded: false, semanticOnly: false },
      noMemory: true,
    },
  };
}

function createFailureResult(code = 'MEMORY_RETRIEVAL_FAILURE', message = 'Memory retrieval is temporarily unavailable.') {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

function hashIdentifier(value) {
  if (value === null || value === undefined || value === '') {
    return 'none';
  }

  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function safeMemorySummary(memory) {
  if (!memory || typeof memory !== 'object') {
    return null;
  }

  return {
    id: hashIdentifier(memory.id || memory._id),
    type: memory.type || null,
    status: memory.status || null,
    importance: Number.isFinite(Number(memory.importance)) ? Number(memory.importance) : null,
    confidence: Number.isFinite(Number(memory.confidence)) ? Number(memory.confidence) : null,
    source: memory.source && typeof memory.source === 'object' ? memory.source.type || null : null,
  };
}

module.exports = {
  normalizeOptions,
  validateUserId,
  createNoMemoryResult,
  createFailureResult,
  hashIdentifier,
  safeMemorySummary,
};
