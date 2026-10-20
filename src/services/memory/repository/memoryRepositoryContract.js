'use strict';

class MemoryRepositoryContract {
  async create() {
    throw new Error('MemoryRepository.create() must be implemented by the concrete repository.');
  }

  async getById() {
    throw new Error('MemoryRepository.getById() must be implemented by the concrete repository.');
  }

  async getManyByIds() {
    throw new Error('MemoryRepository.getManyByIds() must be implemented by the concrete repository.');
  }

  async findByUser() {
    throw new Error('MemoryRepository.findByUser() must be implemented by the concrete repository.');
  }

  async findActiveByUser() {
    throw new Error('MemoryRepository.findActiveByUser() must be implemented by the concrete repository.');
  }

  async findByType() {
    throw new Error('MemoryRepository.findByType() must be implemented by the concrete repository.');
  }

  async update() {
    throw new Error('MemoryRepository.update() must be implemented by the concrete repository.');
  }

  async supersede() {
    throw new Error('MemoryRepository.supersede() must be implemented by the concrete repository.');
  }

  async archive() {
    throw new Error('MemoryRepository.archive() must be implemented by the concrete repository.');
  }

  async delete() {
    throw new Error('MemoryRepository.delete() must be implemented by the concrete repository.');
  }
}

module.exports = {
  MemoryRepositoryContract,
};
