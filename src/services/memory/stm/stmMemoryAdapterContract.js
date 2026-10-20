'use strict';

class StmMemoryAdapterContract {
  async getRecentContext() {
    throw new Error('StmMemoryAdapterContract.getRecentContext() must be implemented.');
  }
}

module.exports = {
  StmMemoryAdapterContract,
};
