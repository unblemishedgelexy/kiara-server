/**
 * Working Memory Error Classes
 */

class WorkingMemoryError extends Error {
  constructor(message, code = 'WORKING_MEMORY_ERROR') {
    super(message);
    this.name = 'WorkingMemoryError';
    this.code = code;
  }
}

class RedisConnectionError extends WorkingMemoryError {
  constructor(message) {
    super(message, 'REDIS_CONNECTION_ERROR');
    this.name = 'RedisConnectionError';
  }
}

class RedisTimeoutError extends WorkingMemoryError {
  constructor(message) {
    super(message, 'REDIS_TIMEOUT_ERROR');
    this.name = 'RedisTimeoutError';
  }
}

class InvalidUserError extends WorkingMemoryError {
  constructor(userId) {
    super(`Invalid userId: ${userId}`, 'INVALID_USER_ERROR');
    this.name = 'InvalidUserError';
  }
}

class MissingSessionError extends WorkingMemoryError {
  constructor(sessionId) {
    super(`Missing sessionId: ${sessionId}`, 'MISSING_SESSION_ERROR');
    this.name = 'MissingSessionError';
  }
}

class EmptyMessageError extends WorkingMemoryError {
  constructor(type) {
    super(`Empty ${type} message`, 'EMPTY_MESSAGE_ERROR');
    this.name = 'EmptyMessageError';
  }
}

class JSONParseError extends WorkingMemoryError {
  constructor(message) {
    super(`JSON parse failure: ${message}`, 'JSON_PARSE_ERROR');
    this.name = 'JSONParseError';
  }
}

class MemoryOverflowError extends WorkingMemoryError {
  constructor(message) {
    super(message, 'MEMORY_OVERFLOW_ERROR');
    this.name = 'MemoryOverflowError';
  }
}

class GeminiResponseError extends WorkingMemoryError {
  constructor(message) {
    super(`Gemini response failure: ${message}`, 'GEMINI_RESPONSE_ERROR');
    this.name = 'GeminiResponseError';
  }
}

module.exports = {
  WorkingMemoryError,
  RedisConnectionError,
  RedisTimeoutError,
  InvalidUserError,
  MissingSessionError,
  EmptyMessageError,
  JSONParseError,
  MemoryOverflowError,
  GeminiResponseError,
};
