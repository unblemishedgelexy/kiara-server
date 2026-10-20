'use strict';

class SemanticIndexError extends Error {
  constructor(message, code = 'SEMANTIC_INFRASTRUCTURE_FAILURE', cause = null) {
    super(message);
    this.name = 'SemanticIndexError';
    this.code = code;
    this.cause = cause;
  }
}

class SemanticIndexContract {
  async upsert() {
    throw new Error('SemanticIndexContract.upsert() must be implemented.');
  }

  async get() {
    throw new Error('SemanticIndexContract.get() must be implemented.');
  }

  async delete() {
    throw new Error('SemanticIndexContract.delete() must be implemented.');
  }

  async query() {
    throw new Error('SemanticIndexContract.query() must be implemented.');
  }
}

module.exports = {
  SemanticIndexContract,
  SemanticIndexError,
};
