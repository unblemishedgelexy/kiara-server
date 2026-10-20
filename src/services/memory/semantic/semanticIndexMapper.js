'use strict';

const { createHash } = require('crypto');

const NAMESPACE = 'canonical-memories';
const MEMORY_STATUSES = new Set(['NEW', 'CANDIDATE', 'ACTIVE', 'SUPERSEDED', 'EXPIRED', 'ARCHIVED']);

function signalValue(signal, fallback = 0) {
  const value = Number(signal && typeof signal === 'object' ? signal.value : signal);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function toSemanticText(memory) {
  if (!memory || typeof memory !== 'object') {
    throw new TypeError('A canonical memory object is required.');
  }

  const fields = [
    ['type', memory.type],
    ['subject', memory.subject],
    ['predicate', memory.predicate],
    ['value', memory.value],
    ['content', memory.content],
  ];

  const text = fields
    .map(([label, value]) => [label, String(value || '').replace(/\s+/g, ' ').trim()])
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');

  if (!text) {
    throw new TypeError('Canonical memory has no semantic text.');
  }

  return text;
}

function toVectorId(memory) {
  const id = String(memory && memory.id || '').trim();
  if (!id) {
    throw new TypeError('Canonical memory id is required.');
  }
  return id;
}

function namespaceForUser(userId, baseNamespace = NAMESPACE) {
  const safeUserId = String(userId || '').trim();
  if (!safeUserId) {
    throw new TypeError('userId is required to select a semantic namespace.');
  }
  const prefix = String(baseNamespace || NAMESPACE).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 20) || NAMESPACE;
  const userHash = createHash('sha256').update(safeUserId).digest('hex').slice(0, 24);
  return `${prefix}-u-${userHash}`;
}

function toVectorMetadata(memory) {
  const userId = String(memory && memory.userId || '').trim();
  if (!userId) {
    throw new TypeError('Canonical memory userId is required.');
  }

  const temporal = memory.temporal || {};
  const status = String(memory.status || '').toUpperCase();
  if (!MEMORY_STATUSES.has(status)) {
    throw new TypeError(`Invalid canonical memory status: ${status || '(missing)'}.`);
  }

  const metadata = {
    userId,
    memoryId: toVectorId(memory),
    type: String(memory.type || 'fact').toLowerCase(),
    status,
    version: Math.max(1, Number(memory.version) || 1),
    importance: signalValue(memory.importance, 0.5),
    confidence: signalValue(memory.confidence, 0.5),
  };

  for (const [key, value] of [
    ['validFrom', temporal.validFrom],
    ['validUntil', temporal.validUntil],
  ]) {
    if (value) {
      const timestamp = new Date(value).getTime();
      if (Number.isFinite(timestamp)) {
        metadata[key] = new Date(timestamp).toISOString();
      }
    }
  }

  return metadata;
}

function mapVectorMatch(match = {}) {
  const metadata = match.metadata || {};
  return {
    memoryId: String(metadata.memoryId || match.id || ''),
    userId: String(metadata.userId || ''),
    type: String(metadata.type || ''),
    status: String(metadata.status || '').toUpperCase(),
    version: Number(metadata.version) || 0,
    score: Number(match.score) || 0,
  };
}

module.exports = {
  NAMESPACE,
  toSemanticText,
  toVectorId,
  namespaceForUser,
  toVectorMetadata,
  mapVectorMatch,
};
