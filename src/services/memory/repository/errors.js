'use strict';

class MemoryRepositoryError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'MemoryRepositoryError';
    this.cause = options.cause || null;
  }
}

class MemoryNotFoundError extends MemoryRepositoryError {
  constructor(userId, memoryId, cause = null) {
    super(`Memory not found for userId=${userId} and memoryId=${memoryId}`);
    this.name = 'MemoryNotFoundError';
    this.userId = userId;
    this.memoryId = memoryId;
    this.cause = cause;
  }
}

class MemoryValidationError extends MemoryRepositoryError {
  constructor(message, cause = null) {
    super(message);
    this.name = 'MemoryValidationError';
    this.cause = cause;
  }
}

class MemoryConflictError extends MemoryRepositoryError {
  constructor(message, cause = null) {
    super(message);
    this.name = 'MemoryConflictError';
    this.cause = cause;
  }
}

class MemoryPersistenceError extends MemoryRepositoryError {
  constructor(message, cause = null) {
    super(message);
    this.name = 'MemoryPersistenceError';
    this.cause = cause;
  }
}

module.exports = {
  MemoryRepositoryError,
  MemoryNotFoundError,
  MemoryValidationError,
  MemoryConflictError,
  MemoryPersistenceError,
};
