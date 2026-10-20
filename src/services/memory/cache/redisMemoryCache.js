'use strict';

const { getRedisClient } = require('../../infrastructure/redisService');
const { env } = require('../../../config/env');
const { Memory } = require('../domain/Memory');
const { MemoryCacheContract } = require('./memoryCacheContract');
const { memoryKey, userMemorySetKey } = require('./memoryCacheKeys');
const {
  MemoryCacheError,
  MemoryCacheNotFoundError,
  MemoryCacheSerializationError,
  MemoryCacheInvalidationError,
} = require('./errors');

class RedisMemoryCache extends MemoryCacheContract {
  constructor({ ttlSeconds = Number(env.memoryCacheTtlSeconds || 3600) } = {}) {
    super();
    this.ttlSeconds = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 3600;
  }

  _normalizeUserId(userId) {
    const normalized = String(userId || '').trim();
    if (!normalized) {
      throw new MemoryCacheError('userId is required for cache access.');
    }
    return normalized;
  }

  _normalizeMemoryId(memoryId) {
    const normalized = String(memoryId || '').trim();
    if (!normalized) {
      throw new MemoryCacheError('memoryId is required for cache access.');
    }
    return normalized;
  }

  _serialize(memory) {
    if (!memory || typeof memory !== 'object') {
      throw new MemoryCacheSerializationError('Cache payload must be a canonical Memory object.');
    }

    const canonical = memory && typeof memory.toJSON === 'function' ? memory.toJSON() : memory;
    const model = new Memory(canonical);
    return JSON.stringify(model.toJSON());
  }

  _parse(rawValue, userId, memoryId) {
    if (rawValue === null || rawValue === undefined || rawValue === '') {
      throw new MemoryCacheNotFoundError(userId, memoryId);
    }

    try {
      const parsed = JSON.parse(rawValue);
      if (!parsed || typeof parsed !== 'object') {
        throw new MemoryCacheSerializationError('Cache payload is not an object.');
      }
      return parsed;
    } catch (error) {
      throw new MemoryCacheSerializationError(`Failed to parse cached memory for userId=${userId} and memoryId=${memoryId}.`, error);
    }
  }

  _validateCachedMemory(userId, memory) {
    if (!memory || typeof memory !== 'object') {
      return false;
    }

    const safeUserId = String(memory.userId || '').trim();
    if (!safeUserId || safeUserId !== String(userId || '').trim()) {
      return false;
    }

    const status = String(memory.status || '').trim().toUpperCase();
    if (['SUPERSEDED', 'EXPIRED', 'ARCHIVED'].includes(status)) {
      return false;
    }

    if (memory.version !== undefined && (!Number.isFinite(Number(memory.version)) || Number(memory.version) < 1)) {
      return false;
    }

    if (memory.temporal && memory.temporal.validUntil) {
      const validUntil = new Date(memory.temporal.validUntil);
      if (!Number.isNaN(validUntil.getTime()) && validUntil.getTime() <= Date.now()) {
        return false;
      }
    }

    return true;
  }

  async _getClient() {
    return getRedisClient();
  }

  async get(userId, memoryId) {
    const safeUserId = this._normalizeUserId(userId);
    const safeMemoryId = this._normalizeMemoryId(memoryId);
    const client = await this._getClient();
    const key = memoryKey(safeUserId, safeMemoryId);
    const raw = await client.get(key);
    if (raw === null || raw === undefined) {
      return null;
    }

    try {
      const parsed = this._parse(raw, safeUserId, safeMemoryId);
      if (!this._validateCachedMemory(safeUserId, parsed)) {
        await this.delete(safeUserId, safeMemoryId);
        return null;
      }
      return new Memory(parsed).toJSON();
    } catch (error) {
      if (error instanceof MemoryCacheNotFoundError) {
        return null;
      }
      if (error instanceof MemoryCacheSerializationError) {
        await this.delete(safeUserId, safeMemoryId).catch(() => {});
        return null;
      }
      throw error;
    }
  }

  async set(memory) {
    const canonical = new Memory(memory).toJSON();
    const safeUserId = this._normalizeUserId(canonical.userId);
    const safeMemoryId = this._normalizeMemoryId(canonical.id);
    const client = await this._getClient();
    const key = memoryKey(safeUserId, safeMemoryId);

    await client.set(key, this._serialize(canonical), { EX: this.ttlSeconds });
    await client.sAdd(userMemorySetKey(safeUserId), safeMemoryId);
    await client.expire(userMemorySetKey(safeUserId), this.ttlSeconds);

    return canonical;
  }

  async delete(userId, memoryId) {
    const safeUserId = this._normalizeUserId(userId);
    const safeMemoryId = this._normalizeMemoryId(memoryId);
    const client = await this._getClient();
    const key = memoryKey(safeUserId, safeMemoryId);

    try {
      await client.del(key);
      await client.sRem(userMemorySetKey(safeUserId), safeMemoryId);
      return true;
    } catch (error) {
      throw new MemoryCacheInvalidationError(`Failed to delete cached memory userId=${safeUserId} memoryId=${safeMemoryId}`, error);
    }
  }

  async getByUser(userId) {
    const safeUserId = this._normalizeUserId(userId);
    const client = await this._getClient();
    const ids = await client.sMembers(userMemorySetKey(safeUserId));
    const memories = await Promise.all(ids.map(async (memoryId) => this.get(safeUserId, memoryId)));
    return memories.filter(Boolean);
  }

  async setMany(userId, memories) {
    const safeUserId = this._normalizeUserId(userId);
    if (!Array.isArray(memories)) {
      return [];
    }

    const saved = await Promise.all(memories.map(async (memory) => {
      const normalized = new Memory(memory).toJSON();
      await this.set(normalized);
      return normalized;
    }));

    return saved.filter((memory) => memory && memory.userId === safeUserId);
  }

  async invalidate(userId, memoryId) {
    return this.delete(userId, memoryId);
  }

  async invalidateUser(userId) {
    const safeUserId = this._normalizeUserId(userId);
    const client = await this._getClient();
    const setKey = userMemorySetKey(safeUserId);
    const ids = await client.sMembers(setKey);

    if (ids.length > 0) {
      await Promise.all(ids.map(async (memoryId) => client.del(memoryKey(safeUserId, memoryId))));
    }

    await client.del(setKey);
    return ids.length;
  }
}

module.exports = {
  RedisMemoryCache,
};
