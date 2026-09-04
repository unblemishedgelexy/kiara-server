'use strict';

/**
 * User Memory Wipe Service
 * 
 * Orchestrates complete, safe user-scoped memory deletion across:
 * - Redis (working, semantic, relationships, promotion metadata, stats, links)
 * - Pinecone (user-scoped episode vectors)
 * - Mongo (ConversationTurn archive and PersonProfile identity data)
 * 
 * Policy decisions:
 * - Mongo ConversationTurn: DELETE
 * - Mongo PersonProfile: DELETE
 * - Browser storage: NOTIFY (frontend clears its own storage)
 * - Concurrent wipes: PREVENTED via wipe lock
 * - Promotion worker: GUARDED (checks working key exists before promotion)
 */

const redisService = require('../../infrastructure/redisService');
const mongoose = require('mongoose');
const pineconeService = require('../../pineconeService');
const WorkingMemoryRedis = require('../../workingMemory/redisOperations');
const logger = require('../utils/memoryLogger');
const ConversationTurn = require('../../../models/ConversationTurn');
const PersonProfile = require('../../../models/PersonProfile');
const { InvalidUserError } = require('../../../utils/workingMemory/errors');

// Wipe lock TTL: 5 minutes (safety timeout)
const WIPE_LOCK_TTL_SECONDS = 300;

// ────────────────────────────────────────────────────────────────────
// Wipe Lock: Prevent concurrent wipes for the same user
// ────────────────────────────────────────────────────────────────────

function buildWipeLockKey(userId) {
  return `memory:wipe:lock:${userId}`;
}

async function acquireWipeLock(userId) {
  try {
    const client = await redisService.getRedisClient();
    if (!client) throw new Error('Redis client not initialized');
    
    const lockKey = buildWipeLockKey(userId);
    const lockId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    
    // SET NX EX: set only if not exists, expire after TTL
    const result = await client.set(lockKey, lockId, { NX: true, EX: WIPE_LOCK_TTL_SECONDS });
    
    if (!result) {
      return null; // Lock already held by another wipe
    }
    
    return lockId;
  } catch (err) {
    logger.logError('WIPE_LOCK_ACQUIRE_ERROR', err.message || String(err), err.stack || null, userId, '');
    return null;
  }
}

async function releaseWipeLock(userId, lockId) {
  try {
    const client = await redisService.getRedisClient();
    if (!client) return;
    
    const lockKey = buildWipeLockKey(userId);
    const currentValue = await client.get(lockKey);
    
    // Only release if lock value matches (prevent accidental release of other's lock)
    if (currentValue === lockId) {
      await client.del(lockKey);
    }
  } catch (err) {
    logger.logError('WIPE_LOCK_RELEASE_ERROR', err.message || String(err), err.stack || null, userId, '');
  }
}

async function isWipeInProgress(userId) {
  try {
    const client = await redisService.getRedisClient();
    if (!client) return false;
    return Boolean(await client.exists(buildWipeLockKey(userId)));
  } catch (err) {
    logger.logError('WIPE_LOCK_CHECK_ERROR', err.message || String(err), err.stack || null, userId, '');
    return true;
  }
}

// ────────────────────────────────────────────────────────────────────
// Redis Deletion: All user-scoped Redis stores
// ────────────────────────────────────────────────────────────────────

async function deleteRedisWorking(userId) {
  try {
    const client = await redisService.getRedisClient();
    if (!client) throw new Error('Redis client not initialized');
    
    const key = WorkingMemoryRedis.buildKey(userId);
    const deleted = await client.del(key);
    
    return {
      deleted: true,
      count: Number(deleted) || 0,
    };
  } catch (err) {
    return {
      deleted: false,
      count: 0,
      error: err.message || String(err),
    };
  }
}

async function deleteRedisSemantic(userId) {
  try {
    const client = await redisService.getRedisClient();
    if (!client) throw new Error('Redis client not initialized');
    
    const key = WorkingMemoryRedis.buildSemanticMemoryKey(userId);
    
    // Hard delete the entire semantic hash (all states: active, superseded, rejected, deleted)
    const deleted = await client.del(key);
    
    return {
      deleted: true,
      fields: Number(deleted) || 0,
    };
  } catch (err) {
    return {
      deleted: false,
      fields: 0,
      error: err.message || String(err),
    };
  }
}

async function deleteRedisRelationships(userId) {
  try {
    const client = await redisService.getRedisClient();
    if (!client) throw new Error('Redis client not initialized');
    
    const key = WorkingMemoryRedis.buildRelationshipKey(userId);
    const deleted = await client.del(key);
    
    return {
      deleted: true,
      count: Number(deleted) || 0,
    };
  } catch (err) {
    return {
      deleted: false,
      count: 0,
      error: err.message || String(err),
    };
  }
}

async function deleteRedisPromotionMetadata(userId) {
  try {
    const client = await redisService.getRedisClient();
    if (!client) throw new Error('Redis client not initialized');
    
    const metaKey = WorkingMemoryRedis.buildPromotionMetaKey(userId);
    const deleted = await client.del(metaKey);
    
    return {
      deleted: true,
      count: Number(deleted) || 0,
    };
  } catch (err) {
    return {
      deleted: false,
      count: 0,
      error: err.message || String(err),
    };
  }
}

async function deleteRedisPromotionQueue(userId) {
  try {
    const client = await redisService.getRedisClient();
    if (!client) throw new Error('Redis client not initialized');
    
    const queueKey = WorkingMemoryRedis.buildPromotionQueueKey();
    // Remove only this user from the global sorted-set (ZREM)
    const removed = await client.zRem(queueKey, String(userId));
    
    return {
      removed: true,
      count: Number(removed) || 0,
    };
  } catch (err) {
    return {
      removed: false,
      count: 0,
      error: err.message || String(err),
    };
  }
}

async function deleteRedisPromotedEpisodes(userId) {
  try {
    const client = await redisService.getRedisClient();
    if (!client) throw new Error('Redis client not initialized');
    
    const promotedKey = WorkingMemoryRedis.buildPromotedEpisodesKey(userId);
    const deleted = await client.del(promotedKey);
    
    return {
      deleted: true,
      count: Number(deleted) || 0,
    };
  } catch (err) {
    return {
      deleted: false,
      count: 0,
      error: err.message || String(err),
    };
  }
}

async function deleteRedisEpisodeLinks(userId, episodeIds = []) {
  try {
    const client = await redisService.getRedisClient();
    if (!client) throw new Error('Redis client not initialized');
    
    let deletedCount = 0;

    for (const episodeId of episodeIds || []) {
      const deleted = await client.del(WorkingMemoryRedis.buildEpisodeLinkKey(episodeId));
      if (deleted > 0) deletedCount += 1;
    }
    
    return {
      deleted: true,
      count: deletedCount,
    };
  } catch (err) {
    return {
      deleted: false,
      count: 0,
      error: err.message || String(err),
    };
  }
}

async function deleteRedisStats(userId, episodeIds = []) {
  try {
    const client = await redisService.getRedisClient();
    if (!client) throw new Error('Redis client not initialized');
    
    let deletedCount = 0;

    for (const episodeId of episodeIds || []) {
      const deleted = await client.del(WorkingMemoryRedis.buildMemoryStatsKey(episodeId));
      if (deleted > 0) deletedCount += 1;
    }
    
    return {
      deleted: true,
      count: deletedCount,
    };
  } catch (err) {
    return {
      deleted: false,
      count: 0,
      error: err.message || String(err),
    };
  }
}

// ────────────────────────────────────────────────────────────────────
// Pinecone Deletion: User-scoped vectors in episodes namespace
// ────────────────────────────────────────────────────────────────────

async function deletePineconeVectors(userId) {
  try {
    if (!pineconeService || typeof pineconeService.deleteLongTermVectorsByMetadata !== 'function') {
      return {
        deleted: false,
        count: 0,
        error: 'Filtered Pinecone deletion is unavailable in the integration',
      };
    }

    const result = await pineconeService.deleteLongTermVectorsByMetadata({ userId }, 'episodes');
    return {
      deleted: result.deleted === true,
      count: Number(result.count) || 0,
      ...(result.error ? { error: result.error } : {}),
      note: result.deleted ? 'Filtered delete requested; Pinecone does not return a deleted count' : undefined,
    };
  } catch (err) {
    return {
      deleted: false,
      count: 0,
      error: err.message || String(err),
    };
  }
}

// ────────────────────────────────────────────────────────────────────
// Mongo Deletion: Archive and Identity data
// ────────────────────────────────────────────────────────────────────

async function deleteMongoConversationTurn(userId) {
  try {
    if (!ConversationTurn) {
      return {
        deleted: true,
        count: 0,
        note: 'ConversationTurn model not available',
      };
    }
    
    const result = await ConversationTurn.deleteMany({ userId });
    
    return {
      deleted: true,
      count: result.deletedCount || 0,
      policy: 'delete',
    };
  } catch (err) {
    return {
      deleted: false,
      count: 0,
      policy: 'delete',
      error: err.message || String(err),
    };
  }
}

async function deleteMongoPersonProfile(userId) {
  try {
    if (!PersonProfile) {
      return {
        deleted: true,
        count: 0,
        note: 'PersonProfile model not available',
      };
    }
    
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return {
        deleted: false,
        count: 0,
        policy: 'delete',
        error: 'Authenticated userId is not a valid Mongo ObjectId',
      };
    }

    const userObjectId = new mongoose.Types.ObjectId(userId);
    const result = await PersonProfile.deleteMany({ userId: userObjectId });
    
    return {
      deleted: true,
      count: result.deletedCount || 0,
      policy: 'delete',
    };
  } catch (err) {
    return {
      deleted: false,
      count: 0,
      policy: 'delete',
      error: err.message || String(err),
    };
  }
}

// ────────────────────────────────────────────────────────────────────
// Main Wipe Orchestration
// ────────────────────────────────────────────────────────────────────

async function wipeUserMemory(userId, options = {}) {
  if (!userId || typeof userId !== 'string' || !userId.trim()) {
    throw new InvalidUserError(userId);
  }

  const normalizedUserId = String(userId).trim();
  const reason = options.reason || 'user_request';
  if (reason !== 'user_request' && reason !== 'admin_command') {
    throw new Error('Invalid wipe reason');
  }
  const wipedAt = new Date().toISOString();

  logger.log('WIPE_START', {
    userId: normalizedUserId,
    reason,
    timestamp: wipedAt,
  });

  // Acquire wipe lock to prevent concurrent wipes
  const lockId = await acquireWipeLock(normalizedUserId);
  if (!lockId) {
    logger.logError('WIPE_ALREADY_IN_PROGRESS', 'Another wipe is in progress for this user', null, normalizedUserId, '');
    return {
      success: false,
      timestamp: wipedAt,
      userId: normalizedUserId,
      error: 'Another wipe is already in progress for this user',
    };
  }

  const results = {
    redisWorking: null,
    redisSemantic: null,
    redisRelationships: null,
    redisPromotionMetadata: null,
    redisPromotionQueue: null,
    redisPromotedEpisodes: null,
    redisEpisodeLinks: null,
    redisStats: null,
    pinecone: null,
    mongoConversation: null,
    mongoPersonProfile: null,
  };

  try {
    let ownedEpisodeIds = [];
    let ownershipError = null;
    try {
      const redisClient = await redisService.getRedisClient();
      if (redisClient) {
        ownedEpisodeIds = await redisClient.sMembers(WorkingMemoryRedis.buildPromotedEpisodesKey(normalizedUserId));
      } else {
        ownershipError = 'Redis client not initialized';
      }
    } catch (err) {
      ownershipError = err.message || String(err);
      logger.logError('WIPE_EPISODE_OWNERSHIP_ERROR', err.message || String(err), err.stack || null, normalizedUserId, '');
    }

    // Tier 1: Delete immediate Redis stores (working, semantic, relationships)
    results.redisWorking = await deleteRedisWorking(normalizedUserId);
    results.redisSemantic = await deleteRedisSemantic(normalizedUserId);
    results.redisRelationships = await deleteRedisRelationships(normalizedUserId);

    // Tier 2: Delete promotion state (metadata, queue membership, promoted sets)
    results.redisPromotionMetadata = await deleteRedisPromotionMetadata(normalizedUserId);
    results.redisPromotionQueue = await deleteRedisPromotionQueue(normalizedUserId);
    results.redisPromotedEpisodes = await deleteRedisPromotedEpisodes(normalizedUserId);

    // Tier 3: Delete indirect ownership keys (episode links, stats)
    results.redisEpisodeLinks = ownershipError
      ? { deleted: false, count: 0, error: ownershipError }
      : await deleteRedisEpisodeLinks(normalizedUserId, ownedEpisodeIds);
    results.redisStats = ownershipError
      ? { deleted: false, count: 0, error: ownershipError }
      : await deleteRedisStats(normalizedUserId, ownedEpisodeIds);

    // Tier 4: Delete Pinecone vectors
    results.pinecone = await deletePineconeVectors(normalizedUserId);

    // Tier 5: Delete Mongo archive and identity data
    results.mongoConversation = await deleteMongoConversationTurn(normalizedUserId);
    results.mongoPersonProfile = await deleteMongoPersonProfile(normalizedUserId);
  } finally {
    // Always release lock
    await releaseWipeLock(normalizedUserId, lockId);
  }

  // Determine overall success: all required stores must complete
  const redisSuccess = results.redisWorking && results.redisWorking.deleted !== false
    && results.redisSemantic && results.redisSemantic.deleted !== false
    && results.redisRelationships && results.redisRelationships.deleted !== false
    && results.redisPromotionMetadata && results.redisPromotionMetadata.deleted !== false
    && results.redisPromotionQueue && results.redisPromotionQueue.removed !== false
    && results.redisPromotedEpisodes && results.redisPromotedEpisodes.deleted !== false
    && results.redisEpisodeLinks && results.redisEpisodeLinks.deleted !== false
    && results.redisStats && results.redisStats.deleted !== false;

  const externalSuccess = results.pinecone && results.pinecone.deleted !== false
    && results.mongoConversation && results.mongoConversation.deleted !== false
    && results.mongoPersonProfile && results.mongoPersonProfile.deleted !== false;

  const overallSuccess = redisSuccess && externalSuccess;

  const response = {
    success: overallSuccess,
    timestamp: wipedAt,
    userId: normalizedUserId,
    reason,
    browserWipeRequired: true, // Frontend must clear its own storage
    results,
  };

  logger.log('WIPE_COMPLETE', {
    userId: normalizedUserId,
    success: overallSuccess,
    timestamp: wipedAt,
    results: Object.entries(results).reduce((acc, [key, val]) => {
      acc[key] = val && val.error ? 'ERROR' : (val && val.deleted !== undefined ? (val.deleted ? 'OK' : 'FAILED') : (val && val.removed !== undefined ? (val.removed ? 'OK' : 'FAILED') : 'UNKNOWN'));
      return acc;
    }, {}),
  });

  return response;
}

module.exports = {
  wipeUserMemory,
  isWipeInProgress,
  buildWipeLockKey,
};
