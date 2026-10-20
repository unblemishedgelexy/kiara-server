'use strict';

const { RedisMemoryCache } = require('./redisMemoryCache');
const { MemoryCacheContract } = require('./memoryCacheContract');
const {
  MemoryCacheError,
  MemoryCacheNotFoundError,
  MemoryCacheSerializationError,
  MemoryCacheInvalidationError,
} = require('./errors');
const { MEMORY_CACHE_NAMESPACE, memoryKey, userMemorySetKey } = require('./memoryCacheKeys');

module.exports = {
  RedisMemoryCache,
  MemoryCacheContract,
  MemoryCacheError,
  MemoryCacheNotFoundError,
  MemoryCacheSerializationError,
  MemoryCacheInvalidationError,
  MEMORY_CACHE_NAMESPACE,
  memoryKey,
  userMemorySetKey,
};
