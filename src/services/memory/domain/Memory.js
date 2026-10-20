'use strict';

const { v4: uuidv4 } = require('uuid');
const { MEMORY_TYPES, normalizeMemoryType, isValidMemoryType } = require('./MemoryType');
const { MEMORY_STATUSES, normalizeMemoryStatus, isValidMemoryStatus } = require('./MemoryStatus');
const { normalizeMemorySource } = require('./MemorySource');
const { normalizeMemoryRelation } = require('./MemoryRelation');
const { normalizeLifecycleEntry } = require('./MemoryLifecycle');

function clamp01(value, fallback = 0.5) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, numeric));
}

function normalizeSignal(input, fallbackLabel = 'MEDIUM') {
  if (typeof input === 'number') {
    const value = clamp01(input, 0.5);
    const label = value >= 0.8 ? 'HIGH' : value >= 0.45 ? 'MEDIUM' : 'LOW';
    return { value, label };
  }

  if (input && typeof input === 'object') {
    const value = clamp01(input.value ?? input.score ?? 0.5, 0.5);
    const label = String(input.label || input.level || '').trim().toUpperCase();
    const normalizedLabel = ['HIGH', 'MEDIUM', 'LOW'].includes(label) ? label : (value >= 0.8 ? 'HIGH' : value >= 0.45 ? 'MEDIUM' : 'LOW');
    return { value, label: normalizedLabel };
  }

  const defaultValue = clamp01(0.5, 0.5);
  return { value: defaultValue, label: fallbackLabel };
}

function normalizeTemporal(temporal = {}) {
  const validFrom = temporal.validFrom || null;
  const validUntil = temporal.validUntil || null;
  const lastConfirmedAt = temporal.lastConfirmedAt || null;

  if (validFrom && Number.isNaN(new Date(validFrom).getTime())) {
    throw new Error('Invalid temporal.validFrom value.');
  }

  if (validUntil && Number.isNaN(new Date(validUntil).getTime())) {
    throw new Error('Invalid temporal.validUntil value.');
  }

  return {
    validFrom,
    validUntil,
    lastConfirmedAt,
  };
}

class Memory {
  constructor(input = {}) {
    const normalized = Memory.normalize(input);
    Object.assign(this, normalized);
    Memory.assertValidMemory(this);
  }

  static normalize(input = {}) {
    const memory = input && typeof input === 'object' ? input : {};
    const type = normalizeMemoryType(memory.type || 'fact');
    if (!isValidMemoryType(type)) {
      throw new Error(`Invalid memory type: ${memory.type}`);
    }

    const userId = String(memory.userId || '').trim();
    if (!userId) {
      throw new Error('Memory.userId is required.');
    }

    const status = normalizeMemoryStatus(memory.status || 'ACTIVE');
    if (!isValidMemoryStatus(status)) {
      throw new Error(`Invalid memory status: ${memory.status}`);
    }

    const source = normalizeMemorySource(memory.source || {});

    const temporal = normalizeTemporal(memory.temporal || {});
    const lifecycle = normalizeLifecycleEntry(memory.lifecycle || {});
    const relations = Array.isArray(memory.relations)
      ? memory.relations.map((relation) => normalizeMemoryRelation(relation))
      : [];

    const subject = memory.subject !== undefined && memory.subject !== null ? String(memory.subject).trim() : '';
    const predicate = memory.predicate !== undefined && memory.predicate !== null ? String(memory.predicate).trim() : '';
    const value = memory.value !== undefined && memory.value !== null ? String(memory.value).trim() : '';
    const content = memory.content !== undefined && memory.content !== null ? String(memory.content).trim() : (value || subject || '');

    if (!content) {
      throw new Error('Memory content or value is required.');
    }

    if (!subject && !predicate && !value) {
      throw new Error('Memory must include subject, predicate, or value.');
    }

    const confidence = normalizeSignal(memory.confidence ?? 0.7, 'MEDIUM');
    const importance = normalizeSignal(memory.importance ?? 0.6, 'MEDIUM');

    const provenance = memory.provenance && typeof memory.provenance === 'object' ? memory.provenance : {};
    const metadata = memory.metadata && typeof memory.metadata === 'object' ? memory.metadata : {};
    const version = Number(memory.version ?? 1);
    const id = memory.id || `mem_${uuidv4()}`;

    const lifecycleField = {
      ...lifecycle,
      createdAt: lifecycle.createdAt || new Date().toISOString(),
      updatedAt: lifecycle.updatedAt || lifecycle.createdAt || new Date().toISOString(),
    };

    return {
      id,
      userId,
      type,
      subject,
      predicate,
      value,
      content,
      source,
      confidence,
      importance,
      status,
      temporal,
      lifecycle: lifecycleField,
      relations,
      provenance,
      version,
      metadata,
    };
  }

  static assertValidMemory(memory) {
    if (!memory || typeof memory !== 'object') {
      throw new Error('Memory contract requires an object value.');
    }

    if (!memory.userId || typeof memory.userId !== 'string') {
      throw new Error('Memory.userId is required.');
    }

    if (!isValidMemoryType(memory.type)) {
      throw new Error(`Invalid memory type: ${memory.type}`);
    }

    if (!isValidMemoryStatus(memory.status)) {
      throw new Error(`Invalid memory status: ${memory.status}`);
    }

    if (!memory.content || typeof memory.content !== 'string') {
      throw new Error('Memory.content is required and must be a string.');
    }

    if (!memory.source || typeof memory.source !== 'object') {
      throw new Error('Memory.source is required.');
    }

    if (!memory.confidence || typeof memory.confidence !== 'object') {
      throw new Error('Memory.confidence is required.');
    }

    if (!memory.importance || typeof memory.importance !== 'object') {
      throw new Error('Memory.importance is required.');
    }

    if (memory.temporal && typeof memory.temporal === 'object') {
      if (memory.temporal.validFrom && Number.isNaN(new Date(memory.temporal.validFrom).getTime())) {
        throw new Error('Invalid memory.temporal.validFrom');
      }
      if (memory.temporal.validUntil && Number.isNaN(new Date(memory.temporal.validUntil).getTime())) {
        throw new Error('Invalid memory.temporal.validUntil');
      }
    }

    if (memory.relations && !Array.isArray(memory.relations)) {
      throw new Error('Memory.relations must be an array.');
    }

    for (const relation of memory.relations || []) {
      normalizeMemoryRelation(relation);
    }

    return true;
  }

  static fromJSON(jsonString) {
    if (!jsonString) {
      return null;
    }

    const data = typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString;
    return new Memory(data);
  }

  toJSON() {
    return {
      id: this.id,
      userId: this.userId,
      type: this.type,
      subject: this.subject,
      predicate: this.predicate,
      value: this.value,
      content: this.content,
      source: this.source,
      confidence: this.confidence,
      importance: this.importance,
      status: this.status,
      temporal: this.temporal,
      lifecycle: this.lifecycle,
      relations: this.relations,
      provenance: this.provenance,
      version: this.version,
      metadata: this.metadata,
    };
  }

  serialize() {
    return JSON.stringify(this.toJSON());
  }

  static create(input = {}) {
    return new Memory(input);
  }
}

module.exports = {
  Memory,
  MEMORY_TYPES,
};
