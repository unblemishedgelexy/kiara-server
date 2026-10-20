'use strict';

const { Memory } = require('../domain/Memory');

function toIsoDate(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function toMongoDate(value) {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }

  if (value instanceof Date) {
    return value;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed;
}

function mapSignal(signal = {}, fallbackValue = 0.5) {
  const value = Number(signal?.value ?? fallbackValue);
  const label = String(signal?.label || '').trim().toUpperCase() || (value >= 0.8 ? 'HIGH' : value >= 0.45 ? 'MEDIUM' : 'LOW');
  return {
    value: Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallbackValue,
    label,
  };
}

function mapRelation(relation = {}) {
  return {
    type: String(relation.type || '').trim().toUpperCase(),
    targetMemoryId: String(relation.targetMemoryId || relation.target || '').trim(),
    confidence: Number(relation.confidence ?? 0.5),
    metadata: relation.metadata || {},
  };
}

class MemoryMapper {
  static toDomain(document) {
    const plain = document && typeof document.toObject === 'function' ? document.toObject() : (document || {});

    return new Memory({
      id: plain.id,
      userId: plain.userId,
      type: plain.type,
      subject: plain.subject,
      predicate: plain.predicate,
      value: plain.value,
      content: plain.content,
      source: {
        type: plain.source?.type,
        reference: plain.source?.reference || null,
        timestamp: toIsoDate(plain.source?.timestamp),
      },
      confidence: {
        value: plain.confidence?.value ?? 0.5,
        label: plain.confidence?.label || 'MEDIUM',
      },
      importance: {
        value: plain.importance?.value ?? 0.5,
        label: plain.importance?.label || 'MEDIUM',
      },
      status: plain.status,
      temporal: {
        validFrom: toIsoDate(plain.temporal?.validFrom),
        validUntil: toIsoDate(plain.temporal?.validUntil),
        lastConfirmedAt: toIsoDate(plain.temporal?.lastConfirmedAt),
      },
      lifecycle: {
        createdAt: toIsoDate(plain.lifecycle?.createdAt),
        updatedAt: toIsoDate(plain.lifecycle?.updatedAt),
        lastAccessedAt: toIsoDate(plain.lifecycle?.lastAccessedAt),
        lastConfirmedAt: toIsoDate(plain.lifecycle?.lastConfirmedAt),
      },
      relations: Array.isArray(plain.relations) ? plain.relations.map((relation) => ({
        type: relation.type,
        targetMemoryId: relation.targetMemoryId,
        confidence: relation.confidence,
        metadata: relation.metadata || {},
      })) : [],
      provenance: plain.provenance || {},
      version: plain.version ?? 1,
      metadata: plain.metadata || {},
    });
  }

  static toDocument(memory) {
    const source = memory && typeof memory === 'object' ? memory.source || {} : {};
    const lifecycle = memory && typeof memory === 'object' ? memory.lifecycle || {} : {};
    const confidence = mapSignal(memory?.confidence, 0.7);
    const importance = mapSignal(memory?.importance, 0.6);

    return {
      id: String(memory.id || '').trim(),
      userId: String(memory.userId || '').trim(),
      type: String(memory.type || '').trim(),
      subject: String(memory.subject || '').trim(),
      predicate: String(memory.predicate || '').trim(),
      value: String(memory.value || '').trim(),
      content: String(memory.content || '').trim(),
      source: {
        type: String(source.type || 'CONVERSATION').trim().toUpperCase(),
        reference: source.reference ?? null,
        timestamp: toMongoDate(source.timestamp) || new Date(),
      },
      confidence,
      importance,
      status: String(memory.status || 'ACTIVE').trim().toUpperCase(),
      temporal: {
        validFrom: toMongoDate(memory.temporal?.validFrom),
        validUntil: toMongoDate(memory.temporal?.validUntil),
        lastConfirmedAt: toMongoDate(memory.temporal?.lastConfirmedAt),
      },
      lifecycle: {
        createdAt: toMongoDate(lifecycle.createdAt) || new Date(),
        updatedAt: toMongoDate(lifecycle.updatedAt) || new Date(),
        lastAccessedAt: toMongoDate(lifecycle.lastAccessedAt),
        lastConfirmedAt: toMongoDate(lifecycle.lastConfirmedAt),
      },
      relations: Array.isArray(memory.relations)
        ? memory.relations.map(mapRelation)
        : [],
      provenance: memory.provenance || {},
      version: Number(memory.version ?? 1),
      metadata: memory.metadata || {},
    };
  }
}

module.exports = {
  MemoryMapper,
  toIsoDate,
  toMongoDate,
};
