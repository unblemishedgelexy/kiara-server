'use strict';

const crypto = require('crypto');

const TRACE_PREFIX = 'memtrace';

function createMemoryTraceId(prefix = TRACE_PREFIX) {
  const nonce = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${Date.now().toString(36)}_${nonce}`;
}

function redactSecrets(value, seen = new WeakSet()) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, seen));
  }

  const redacted = {};
  for (const [key, item] of Object.entries(value)) {
    const lower = String(key).toLowerCase();
    if (/(token|secret|cookie|password|api[_-]?key|authorization|bearer|refresh)/.test(lower)) {
      redacted[key] = '[REDACTED]';
      continue;
    }

    redacted[key] = redactSecrets(item, seen);
  }

  return redacted;
}

function normalizeTracePayload(stage, payload = {}, memoryTraceId = null) {
  const output = { ...payload };
  if (!output.stage) output.stage = stage;
  if (!output.memoryTraceId) output.memoryTraceId = memoryTraceId || createMemoryTraceId();
  output.timestamp = output.timestamp || new Date().toISOString();
  return redactSecrets(output);
}

function log(stage, payload = {}, memoryTraceId = null) {
  const entry = normalizeTracePayload(stage, payload, memoryTraceId);
  console.log('[MEMORY_TRACE]', JSON.stringify(entry));
  return entry.memoryTraceId;
}

function withTrace(stage, payload = {}, handler) {
  const memoryTraceId = payload.memoryTraceId || createMemoryTraceId();
  const base = { ...payload, memoryTraceId };
  log(stage, base);
  if (typeof handler !== 'function') {
    return { memoryTraceId };
  }
  return handler(memoryTraceId);
}

module.exports = {
  createMemoryTraceId,
  log,
  withTrace,
  redactSecrets,
  normalizeTracePayload,
};
