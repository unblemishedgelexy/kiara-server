'use strict';

class MemoryCacheError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'MemoryCacheError';
    this.cause = options.cause || null;
  }
}

class MemoryCacheNotFoundError extends MemoryCacheError {
  constructor(userId, memoryId, cause = null) {
    super(`Cached memory not found for userId=${userId} and memoryId=${memoryId}`);
    this.name = 'MemoryCacheNotFoundError';
    this.userId = userId;
    this.memoryId = memoryId;
    this.cause = cause;
  }
}

class MemoryCacheSerializationError extends MemoryCacheError {
  constructor(message, cause = null) {
    super(message);
    this.name = 'MemoryCacheSerializationError';
    this.cause = cause;
  }
}

class MemoryCacheInvalidationError extends MemoryCacheError {
  constructor(message, cause = null) {
    super(message);
    this.name = 'MemoryCacheInvalidationError';
    this.cause = cause;
  }
}

module.exports = {
  MemoryCacheError,
  MemoryCacheNotFoundError,
  MemoryCacheSerializationError,
  MemoryCacheInvalidationError,
};
