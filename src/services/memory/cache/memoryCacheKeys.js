'use strict';

const MEMORY_CACHE_NAMESPACE = 'memory:cache';

function normalizeUserId(userId) {
  return String(userId || '').trim();
}

function normalizeMemoryId(memoryId) {
  return String(memoryId || '').trim();
}

function memoryKey(userId, memoryId) {
  const safeUserId = normalizeUserId(userId);
  const safeMemoryId = normalizeMemoryId(memoryId);
  if (!safeUserId) {
    throw new Error('memoryKey requires a userId value.');
  }
  if (!safeMemoryId) {
    throw new Error('memoryKey requires a memoryId value.');
  }
  return `${MEMORY_CACHE_NAMESPACE}:${safeUserId}:${safeMemoryId}`;
}

function userMemorySetKey(userId) {
  const safeUserId = normalizeUserId(userId);
  if (!safeUserId) {
    throw new Error('userMemorySetKey requires a userId value.');
  }
  return `${MEMORY_CACHE_NAMESPACE}:user:${safeUserId}`;
}

module.exports = {
  MEMORY_CACHE_NAMESPACE,
  memoryKey,
  userMemorySetKey,
};
