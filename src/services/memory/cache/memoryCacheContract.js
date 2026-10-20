'use strict';

class MemoryCacheContract {
  async get() {
    throw new Error('MemoryCacheContract.get() must be implemented by a concrete cache.');
  }

  async set() {
    throw new Error('MemoryCacheContract.set() must be implemented by a concrete cache.');
  }

  async delete() {
    throw new Error('MemoryCacheContract.delete() must be implemented by a concrete cache.');
  }

  async getByUser() {
    throw new Error('MemoryCacheContract.getByUser() must be implemented by a concrete cache.');
  }

  async setMany() {
    throw new Error('MemoryCacheContract.setMany() must be implemented by a concrete cache.');
  }

  async invalidate() {
    throw new Error('MemoryCacheContract.invalidate() must be implemented by a concrete cache.');
  }

  async invalidateUser() {
    throw new Error('MemoryCacheContract.invalidateUser() must be implemented by a concrete cache.');
  }
}

module.exports = {
  MemoryCacheContract,
};
