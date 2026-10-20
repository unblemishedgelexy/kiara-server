'use strict';

const mongoose = require('mongoose');
const MemoryModel = require('../../../models/Memory');
const { Memory } = require('../domain/Memory');
const { MemoryRepositoryContract } = require('./memoryRepositoryContract');
const { MemoryMapper } = require('./memoryMapper');
const {
  MemoryNotFoundError,
  MemoryValidationError,
  MemoryConflictError,
  MemoryPersistenceError,
} = require('./errors');

class MongoMemoryRepository extends MemoryRepositoryContract {
  constructor({ model = MemoryModel } = {}) {
    super();
    this.model = model;
  }

  _assertConnected() {
    if (mongoose.connection?.readyState !== 1) {
      const error = new MemoryPersistenceError('MongoDB is not connected for canonical memory persistence.');
      error.code = 'MONGO_FAILURE';
      throw error;
    }
  }

  _normalizeFilters(userId, filters = {}) {
    const query = { userId: String(userId || '').trim() };
    if (!query.userId) {
      throw new MemoryValidationError('userId is required for memory access.');
    }

    if (filters.type) {
      query.type = String(filters.type).trim();
    }

    if (filters.status) {
      query.status = String(filters.status).trim().toUpperCase();
    }

    if (filters.activeOnly) {
      query.status = { $nin: ['SUPERSEDED', 'EXPIRED', 'ARCHIVED'] };
    }

    if (filters.excludeArchived) {
      const current = query.status;
      query.status = current && typeof current === 'object'
        ? { ...current, $nin: ['SUPERSEDED', 'EXPIRED', 'ARCHIVED'] }
        : { $nin: ['SUPERSEDED', 'EXPIRED', 'ARCHIVED'] };
    }

    if (filters.id) {
      query.id = String(filters.id).trim();
    }

    return query;
  }

  async create(memoryInput) {
    try {
      this._assertConnected();
      const memory = new Memory(memoryInput);
      const document = MemoryMapper.toDocument(memory);
      const created = await this.model.create(document);
      return MemoryMapper.toDomain(created);
    } catch (error) {
      if (error instanceof MemoryValidationError || error instanceof MemoryNotFoundError) {
        throw error;
      }
      if (error && error.code === 11000) {
        throw new MemoryConflictError(`Memory already exists for userId=${memoryInput?.userId} and id=${memoryInput?.id || 'generated'}`, error);
      }
      throw new MemoryPersistenceError('Failed to create memory.', error);
    }
  }

  async getById(userId, memoryId) {
    try {
      this._assertConnected();
      const found = await this.model.findOne({ userId: String(userId || '').trim(), id: String(memoryId || '').trim() }).lean();
      if (!found) {
        throw new MemoryNotFoundError(userId, memoryId);
      }
      return MemoryMapper.toDomain(found);
    } catch (error) {
      if (error instanceof MemoryNotFoundError
        || error instanceof MemoryValidationError
        || error instanceof MemoryConflictError
        || error instanceof MemoryPersistenceError) {
        throw error;
      }
      throw new MemoryPersistenceError('Failed to retrieve memory by id.', error);
    }
  }

  async getManyByIds(userId, memoryIds = []) {
    const normalizedUserId = String(userId || '').trim();
    if (!normalizedUserId) {
      throw new MemoryValidationError('userId is required for memory access.');
    }
    const normalizedIds = [...new Set(
      (Array.isArray(memoryIds) ? memoryIds : [])
        .map((memoryId) => String(memoryId || '').trim())
        .filter(Boolean),
    )];
    if (!normalizedIds.length) return [];

    try {
      this._assertConnected();
      const docs = await this.model.find({
        userId: normalizedUserId,
        id: { $in: normalizedIds },
      }).lean();
      return docs.map((doc) => MemoryMapper.toDomain(doc));
    } catch (error) {
      if (error instanceof MemoryValidationError) throw error;
      throw new MemoryPersistenceError('Failed to retrieve memories by ids.', error);
    }
  }

  async findByUser(userId, options = {}) {
    try {
      this._assertConnected();
      const query = this._normalizeFilters(userId, options);
      const docs = await this.model.find(query)
        .sort(options.sort || { updatedAt: -1 })
        .limit(options.limit ? Math.max(1, Number(options.limit)) : 0)
        .lean();
      return docs.map((doc) => MemoryMapper.toDomain(doc));
    } catch (error) {
      if (error instanceof MemoryValidationError) {
        throw error;
      }
      throw new MemoryPersistenceError('Failed to query memories by user.', error);
    }
  }

  async findActiveByUser(userId, options = {}) {
    this._assertConnected();
    const query = this._normalizeFilters(userId, { ...options, activeOnly: true });
    const docs = await this.model.find(query)
      .sort(options.sort || { updatedAt: -1 })
      .limit(options.limit ? Math.max(1, Number(options.limit)) : 0)
      .lean();
    return docs.map((doc) => MemoryMapper.toDomain(doc));
  }

  async findByType(userId, type, options = {}) {
    try {
      this._assertConnected();
      const query = this._normalizeFilters(userId, { ...options, type });
      const docs = await this.model.find(query)
        .sort(options.sort || { updatedAt: -1 })
        .limit(options.limit ? Math.max(1, Number(options.limit)) : 0)
        .lean();
      return docs.map((doc) => MemoryMapper.toDomain(doc));
    } catch (error) {
      if (error instanceof MemoryValidationError) {
        throw error;
      }
      throw new MemoryPersistenceError('Failed to query memories by type.', error);
    }
  }

  async update(userId, memoryId, changes) {
    try {
      this._assertConnected();
      const current = await this.getById(userId, memoryId);
      const expectedVersion = Number.isFinite(Number(changes?.expectedVersion))
        ? Number(changes.expectedVersion)
        : null;
      const nextVersion = Number(changes?.version ?? (Number(current.version || 1) + 1));
      const merged = new Memory({
        ...current.toJSON(),
        ...changes,
        userId,
        id: memoryId,
        version: nextVersion,
      });

      const nextDocument = MemoryMapper.toDocument(merged);
      const { lifecycle, ...rest } = nextDocument;
      const updated = await this.model.findOneAndUpdate(
        {
          userId: String(userId || '').trim(),
          id: String(memoryId || '').trim(),
          ...(expectedVersion === null ? {} : { version: expectedVersion }),
        },
        {
          $set: {
            ...rest,
            version: nextVersion,
            lifecycle: {
              ...(lifecycle || {}),
              updatedAt: new Date(),
            },
          },
        },
        { returnDocument: 'after', runValidators: true }
      ).lean();

      if (!updated) {
        if (expectedVersion !== null) {
          throw new MemoryConflictError('Memory changed during canonical update; stale version was not written.');
        }
        throw new MemoryNotFoundError(userId, memoryId);
      }

      return MemoryMapper.toDomain(updated);
    } catch (error) {
      if (error instanceof MemoryNotFoundError || error instanceof MemoryValidationError || error instanceof MemoryConflictError) {
        throw error;
      }
      if (error instanceof MemoryPersistenceError) throw error;
      throw new MemoryPersistenceError('Failed to update memory.', error);
    }
  }

  async supersede(userId, memoryId, replacementInput) {
    this._assertConnected();
    const oldMemory = await this.getById(userId, memoryId);
    const replacement = new Memory({
      ...replacementInput,
      userId,
      status: 'ACTIVE',
      version: Number(replacementInput?.version ?? (Number(oldMemory.version || 1) + 1)),
    });
    if (replacement.id === oldMemory.id) {
      throw new MemoryConflictError('Replacement memory id must differ from superseded memory id.');
    }

    const fallbackSupersede = async () => {
      const now = new Date();
      const oldDoc = await this.model.findOneAndUpdate(
        {
          userId: String(userId || '').trim(),
          id: String(memoryId || '').trim(),
          status: 'ACTIVE',
          version: Number(oldMemory.version || 1),
        },
        {
          $set: {
            status: 'SUPERSEDED',
            'lifecycle.updatedAt': now,
            'temporal.lastConfirmedAt': now,
            version: Number(oldMemory.version || 1),
          },
        },
        { returnDocument: 'after', runValidators: true }
      ).lean();

      if (!oldDoc) {
        throw new MemoryConflictError('Memory changed during canonical supersede; stale version was not written.');
      }

      const replacementDocument = MemoryMapper.toDocument(replacement);
      const created = await this.model.create(replacementDocument);
      return {
        previous: MemoryMapper.toDomain(oldDoc),
        replacement: MemoryMapper.toDomain(created),
      };
    };

    try {
      // Mongo transactions require a live replica set / mongos deployment.
      // Standalone MongoDB is common in local/dev environments, so the repository
      // must degrade safely to the same logical operation without crashing.
      if (!mongoose.connection || mongoose.connection.readyState !== 1) {
        return fallbackSupersede();
      }

      const session = await mongoose.startSession();
      let result;
      try {
        await session.withTransaction(async () => {
          const now = new Date();
          const supersededUpdate = {
            status: 'SUPERSEDED',
            'lifecycle.updatedAt': now,
            'temporal.lastConfirmedAt': now,
            version: Number(oldMemory.version || 1),
          };

          const oldDoc = await this.model.findOneAndUpdate(
            {
              userId: String(userId || '').trim(),
              id: String(memoryId || '').trim(),
              status: 'ACTIVE',
              version: Number(oldMemory.version || 1),
            },
            { $set: supersededUpdate },
            { returnDocument: 'after', session, runValidators: true }
          ).lean();

          if (!oldDoc) {
            throw new MemoryConflictError('Memory changed during canonical supersede; stale version was not written.');
          }

          const replacementDocument = MemoryMapper.toDocument(replacement);
          const created = await this.model.create([{ ...replacementDocument, _id: undefined }], { session });

          result = {
            previous: MemoryMapper.toDomain(oldDoc),
            replacement: MemoryMapper.toDomain(created[0]),
          };
        });
      } finally {
        session.endSession();
      }

      return result;
    } catch (error) {
      if (error instanceof MemoryNotFoundError
        || error instanceof MemoryValidationError
        || error instanceof MemoryConflictError
        || error instanceof MemoryPersistenceError) {
        throw error;
      }

      const message = String(error && error.message ? error.message : error || '');
      if (
        !mongoose.connection || mongoose.connection.readyState !== 1 ||
        message.includes('retryable writes') ||
        message.includes('Transaction numbers are only allowed') ||
        (error && error.code === 20)
      ) {
        try {
          return await fallbackSupersede();
        } catch (fallbackError) {
          if (fallbackError instanceof MemoryNotFoundError || fallbackError instanceof MemoryValidationError || fallbackError instanceof MemoryConflictError) {
            throw fallbackError;
          }
          if (fallbackError && fallbackError.code === 11000) {
            throw new MemoryConflictError(`Replacement memory conflict for userId=${userId} and id=${replacement.id}`, fallbackError);
          }
          throw new MemoryPersistenceError('Failed to supersede memory during fallback update path.', fallbackError);
        }
      }

      if (error && error.code === 11000) {
        throw new MemoryConflictError(`Replacement memory conflict for userId=${userId} and id=${replacement.id}`, error);
      }
      throw new MemoryPersistenceError('Failed to supersede memory.', error);
    }
  }

  async archive(userId, memoryId) {
    try {
      const current = await this.getById(userId, memoryId);
      const archived = await this.model.findOneAndUpdate(
        { userId: String(userId || '').trim(), id: String(memoryId || '').trim() },
        {
          $set: {
            status: 'ARCHIVED',
            'lifecycle.updatedAt': new Date(),
            'lifecycle.lastConfirmedAt': new Date(),
          },
        },
        { returnDocument: 'after', runValidators: true }
      ).lean();

      if (!archived) {
        throw new MemoryNotFoundError(userId, memoryId);
      }

      return MemoryMapper.toDomain(archived);
    } catch (error) {
      if (error instanceof MemoryNotFoundError || error instanceof MemoryValidationError) {
        throw error;
      }
      throw new MemoryPersistenceError('Failed to archive memory.', error);
    }
  }

  async delete(userId, memoryId) {
    try {
      const result = await this.model.deleteOne({ userId: String(userId || '').trim(), id: String(memoryId || '').trim() });
      if (result.deletedCount === 0) {
        throw new MemoryNotFoundError(userId, memoryId);
      }
      return true;
    } catch (error) {
      if (error instanceof MemoryNotFoundError) {
        throw error;
      }
      throw new MemoryPersistenceError('Failed to delete memory.', error);
    }
  }
}

module.exports = {
  MongoMemoryRepository,
};
