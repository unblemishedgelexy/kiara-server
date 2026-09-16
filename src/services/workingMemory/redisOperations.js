/*
 * Working Memory Redis Operations
 *
 * Handles all Redis operations for working memory.
 * Provides atomic operations to prevent race conditions.
 */

const redisService = require('../infrastructure/redisService');
const ConversationTurn = require('../../models/ConversationTurn');
const { env } = require('../../config/env');
const {
  RedisConnectionError,
  RedisTimeoutError,
  JSONParseError,
} = require('../../utils/workingMemory/errors');

const MEMORY_SLIDING_WINDOW_MS = 20 * 60 * 1000; // 20 minutes
const INACTIVE_KEY_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const PROMOTION_INTERVAL_MS = 15 * 60 * 1000;
const PROMOTION_QUEUE_TTL_SECONDS = 7 * 24 * 60 * 60;
const PROMOTION_RETRY_BASE_MS = 60 * 1000;
const PROMOTION_RETRY_MAX_MS = 15 * 60 * 1000;
const REJECTED_MEMORY_RETENTION_SECONDS = 7 * 24 * 60 * 60; // 7 days
const REJECTED_MEMORY_CLEANUP_INTERVAL_SECONDS = 24 * 60 * 60; // 24 hours
const SEMANTIC_WRITE_LOCK_TTL_SECONDS = 15;
const SEMANTIC_WRITE_LOCK_RETRIES = 200;
const SEMANTIC_WRITE_LOCK_RETRY_MS = 50;
let rejectedMemoryCleanupTimer = null;

function relatedHasMemoryId(related, memoryId) {
  return Array.from(related.values()).some((item) => item.memoryId === String(memoryId) || item.id === String(memoryId));
}

function buildSemanticVersionId(logicalKey) {
  return `${logicalKey}:version:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
}

async function acquireSemanticWriteLock(client, userId) {
  const lockKey = `memory:longterm:semantic:lock:${userId}`;
  const lockId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  for (let attempt = 0; attempt < SEMANTIC_WRITE_LOCK_RETRIES; attempt += 1) {
    const acquired = await client.set(lockKey, lockId, { NX: true, EX: SEMANTIC_WRITE_LOCK_TTL_SECONDS });
    if (acquired) return { lockKey, lockId };
    await new Promise((resolve) => setTimeout(resolve, SEMANTIC_WRITE_LOCK_RETRY_MS));
  }
  throw new RedisTimeoutError(`Timed out acquiring semantic memory write lock for ${userId}`);
}

async function releaseSemanticWriteLock(client, lock) {
  if (!lock) return;
  try {
    if (await client.get(lock.lockKey) === lock.lockId) {
      await client.del(lock.lockKey);
    }
  } catch {
    // The short TTL remains the fallback if release is interrupted.
  }
}

class WorkingMemoryRedis {
  /**
   * Build Redis key for user memory
   * @param {string} userId
   * @returns {string} Redis key
   */
  static buildKey(userId) {
    return `memory:working:${userId}`;
  }


  static buildPromotionQueueKey() {
    return 'memory:promotion:queue';
  }

  static buildPromotionMetaKey(userId) {
    return `memory:promotion:user:${userId}`;
  }

  static buildPromotedEpisodesKey(userId) {
    return `memory:promotion:promoted:${userId}`;
  }

  static buildSemanticMemoryKey(userId) {
    return `memory:longterm:semantic:${userId}`;
  }

  static buildSemanticMemoryRevisionKey(userId) {
    return `memory:semantic:revision:${userId}`;
  }

  static async getSemanticMemoryRevision(userId) {
    if (!userId) return 0;
    try {
      const client = await redisService.getRedisClient();
      if (!client) throw new RedisConnectionError('Redis client not initialized');
      const revisionKey = this.buildSemanticMemoryRevisionKey(userId);
      const existingRevision = Number(await client.get(revisionKey)) || 0;
      if (existingRevision > 0) return existingRevision;

      const raw = await client.hGetAll(this.buildSemanticMemoryKey(userId));
      const hasCanonicalMemory = Object.values(raw || {}).some((value) => {
        try {
          const item = JSON.parse(value);
          return item
            && this.normalizeStatus(item.status || 'active') === 'active'
            && ['user', 'import'].includes(this.normalizeSource(item.source || 'unknown'));
        } catch {
          return false;
        }
      });
      if (!hasCanonicalMemory) return 0;
      await client.set(revisionKey, '1');
      return 1;
    } catch (error) {
      return 0;
    }
  }

  static flattenHashEntries(fields) {
    if (!fields || typeof fields !== 'object') {
      return [];
    }
    return Object.entries(fields).reduce((acc, [key, value]) => {
      if (key === undefined || key === null || key === '') {
        return acc;
      }
      return acc.concat(String(key), String(value === undefined || value === null ? '' : value));
    }, []);
  }

  static normalizeRedisString(value) {
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : String(value);
  }

  static normalizeSource(source) {
    const normalized = String(source || 'unknown').toLowerCase();
    return ['user', 'assistant', 'system', 'import'].includes(normalized) ? normalized : 'unknown';
  }

  static getSourcePriority(source) {
    const normalized = this.normalizeSource(source);
    const weights = { user: 4, import: 3, system: 2, assistant: 1, unknown: 0 };
    return weights[normalized] ?? 0;
  }

  static isCurrentCanonicalMemory(item) {
    if (!item || typeof item !== 'object') return false;
    const source = this.normalizeSource(item.source || 'unknown');
    const status = this.normalizeStatus(item.status || 'active');
    const confidence = Number(item.confidenceScore || item.confidence || 0);
    return status === 'active'
      && (source === 'import' || item.userOwned === true || item.user_owned === true)
      && item.memoryWorthy !== false
      && confidence >= 0.55;
  }

  static normalizeStatus(status) {
    const normalized = String(status || 'active').toLowerCase();
    if (normalized === 'superseded') return 'superseded';
    if (normalized === 'deleted') return 'deleted';
    if (normalized === 'rejected') return 'rejected';
    return 'active';
  }

  static getRejectedMemoryRetentionSeconds() {
    return REJECTED_MEMORY_RETENTION_SECONDS;
  }

  static getRejectedMemoryCleanupIntervalMs() {
    return REJECTED_MEMORY_CLEANUP_INTERVAL_SECONDS * 1000;
  }

  static getLogicalMemoryKey(item) {
    if (!item || typeof item !== 'object') return 'memory';
    const category = String(item.category || 'memory').toLowerCase();
    let attribute = String(item.attribute || item.key || category || 'memory').toLowerCase();
    if (category === 'identity') {
      attribute = 'name';
    }
    if (category === 'preference') {
      attribute = attribute.replace(/^favourite_/, 'favorite_').replace(/^colour$/, 'color');
    }
    return `${category}:${attribute}`;
  }

  static isPreferredActiveMemory(candidate, current) {
    if (!current) return true;

    const candidatePriority = this.getSourcePriority(candidate.source);
    const currentPriority = this.getSourcePriority(current.source);
    if (candidatePriority !== currentPriority) return candidatePriority > currentPriority;

    const candidateConfidence = Number(candidate.confidenceScore || candidate.confidence || 0);
    const currentConfidence = Number(current.confidenceScore || current.confidence || 0);
    if (candidateConfidence !== currentConfidence) return candidateConfidence > currentConfidence;

    const candidateUpdatedAt = Date.parse(candidate.updatedAt || candidate.createdAt || '') || 0;
    const currentUpdatedAt = Date.parse(current.updatedAt || current.createdAt || '') || 0;
    return candidateUpdatedAt > currentUpdatedAt;
  }

  static removeLogicalKeyEntries(mergedEntries, logicalKey) {
    if (!mergedEntries || typeof mergedEntries !== 'object' || !logicalKey) {
      return mergedEntries;
    }

    for (const [hashKey, entry] of Object.entries(mergedEntries)) {
      if (!entry || typeof entry !== 'object') continue;
      if (this.getLogicalMemoryKey(entry) === logicalKey && this.normalizeStatus(entry.status || 'active') === 'active') {
        delete mergedEntries[hashKey];
      }
    }

    if (mergedEntries[logicalKey] && this.normalizeStatus(mergedEntries[logicalKey].status || 'active') === 'active') {
      delete mergedEntries[logicalKey];
    }
    return mergedEntries;
  }

  static buildHashEntries(fields) {
    if (!fields || typeof fields !== 'object') {
      return [];
    }
    return Object.entries(fields).reduce((acc, [key, value]) => {
      if (key === undefined || key === null || key === '') {
        return acc;
      }
      acc.push(String(key), this.normalizeRedisString(value));
      return acc;
    }, []);
  }

  static createRedisPipeline(client) {
    if (!client) {
      throw new RedisConnectionError('Redis client not initialized');
    }
    if (typeof client.pipeline === 'function') {
      return client.pipeline();
    }
    if (typeof client.multi === 'function') {
      return client.multi();
    }
    throw new RedisConnectionError('Redis client does not support pipeline or multi');
  }

  static async executeRedisPipeline(pipeline, context = {}) {
    try {
      const results = await pipeline.exec();
      if (!results) {
        throw new RedisConnectionError('Redis pipeline execution failed');
      }
      return results;
    } catch (err) {
      if (err && err.message && err.message.includes('EXECABORT')) {
      }
      throw err;
    }
  }

  static normalizeRolePrefix(text) {
    if (!text || typeof text !== 'string') return String(text || '');
    // Also strip 'K:' role used by prompt builder (T/U/K format)
    return text.replace(/^(?:User|U|Kiara|Assistant|A|K)\s*:\s*/i, '').trim();
  }

  static stripLeadingAnimationJson(text) {
    // Generalized removal: strip any JSON object blocks that appear to be
    // animation metadata (emotion/gesture/camera/animation/eyeState/etc.).
    if (!text || typeof text !== 'string') return String(text || '');
    let working = text.trim();

    const animationKeys = ['emotion', 'gesture', 'camera', 'animation', 'eyeState', 'headTilt', 'expression', 'microphone'];

    // Scan the string and remove any {...} blocks that parse as JSON and
    // contain only animation-related keys.
    let i = 0;
    while (i < working.length) {
      if (working[i] !== '{') {
        i += 1;
        continue;
      }

      // Find matching closing brace for this object (simple stack)
      let depth = 0;
      let inString = false;
      let escaped = false;
      let endIndex = -1;
      for (let j = i; j < working.length; j += 1) {
        const ch = working[j];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth += 1;
        if (ch === '}') { depth -= 1; if (depth === 0) { endIndex = j + 1; break; } }
      }

      if (endIndex <= i) {
        // no matching close brace; skip this '{'
        i += 1;
        continue;
      }

      const candidate = working.slice(i, endIndex).trim();
      let parsed = null;
      try {
        parsed = JSON.parse(candidate);
      } catch (e) {
        parsed = null;
      }

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const keys = Object.keys(parsed || {});
        const isAnimation = keys.length > 0 && keys.every((k) => animationKeys.includes(k));
        if (isAnimation) {
          // Remove this block entirely
          working = (working.slice(0, i) + ' ' + working.slice(endIndex)).trim();
          // restart scanning from beginning to be safe
          i = 0;
          continue;
        }
      }

      i = endIndex;
    }

    return working;
  }

  static normalizeMessage(value) {
    if (value === null || value === undefined) return '';

    let text = String(value).trim();
    if (!text) return '';

    text = this.normalizeRolePrefix(text);
    text = this.stripLeadingAnimationJson(text);
    text = text.replace(/\r\n/g, '\n');
    text = text.replace(/\n{2,}/g, '\n');
    text = text.replace(/[ \t]{2,}/g, ' ');
    return text.trim();
  }

  static serializeStoredTurn(turn) {
    // Ensure lossless minimal storage format (T/U/K only)
    const ts = String(turn.timestamp || new Date().toISOString());
    const user = String(turn.userMessage || '').replace(/\n/g, '\\n');
    const assistant = String(turn.assistantMessage || '').replace(/\n/g, '\\n');
    return `T:${ts}\nU:${user}\nK:${assistant}`;
  }

  static parseStoredTurn(item) {
    if (!item || typeof item !== 'string') {
      return null;
    }

    const normalized = item.trim();
    if (normalized.startsWith('T:')) {
      const uIndex = normalized.indexOf('\nU:');
      const kIndex = normalized.lastIndexOf('\nK:');
      if (uIndex > 0 && kIndex > uIndex) {
        const timestamp = normalized.slice(2, uIndex).trim();
        const userMessage = normalized.slice(uIndex + 3, kIndex);
        const assistantMessage = normalized.slice(kIndex + 3);

        if (!timestamp || !userMessage || !assistantMessage) {
          return null;
        }

        const parsedDate = new Date(String(timestamp));
        if (Number.isNaN(parsedDate.valueOf())) {
          return null;
        }

        return {
          timestamp: parsedDate.toISOString(),
          userMessage: String(userMessage).replace(/\\n/g, '\n'),
          assistantMessage: String(assistantMessage).replace(/\\n/g, '\n'),
        };
      }
    }

    let parsed;
    try {
      parsed = JSON.parse(item);
    } catch {
      return null;
    }

    if (Array.isArray(parsed)) {
      const [turnId, timestamp, sessionId, userMessage, assistantMessage] = parsed;
      if (!turnId || !timestamp || !sessionId || !userMessage || !assistantMessage) {
        return null;
      }
      return {
        turnId: String(turnId),
        timestamp: new Date(String(timestamp)).toISOString(),
        sessionId: String(sessionId),
        userMessage: String(userMessage).replace(/\\n/g, '\n'),
        assistantMessage: String(assistantMessage).replace(/\\n/g, '\n'),
        assistantResponse: String(assistantMessage).replace(/\\n/g, '\n'),
        aiResponse: String(assistantMessage).replace(/\\n/g, '\n'),
      };
    }

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const turnId = parsed.turnId || parsed.id || null;
    const timestamp = parsed.timestamp || parsed.ts || null;
    const sessionId = parsed.sessionId || parsed.session || '';
    const userMessage = parsed.userMessage ?? parsed.user ?? '';
    const assistantMessage = parsed.assistantMessage ?? parsed.assistantResponse ?? parsed.aiResponse ?? '';

    if (!turnId || !timestamp || !sessionId || !userMessage || !assistantMessage) {
      return null;
    }

    return {
      turnId: String(turnId),
      timestamp: new Date(String(timestamp)).toISOString(),
      sessionId: String(sessionId),
      userMessage: String(userMessage).replace(/\\n/g, '\n'),
      assistantMessage: String(assistantMessage).replace(/\\n/g, '\n'),
      assistantResponse: String(assistantMessage).replace(/\\n/g, '\n'),
      aiResponse: String(assistantMessage).replace(/\\n/g, '\n'),
    };
  }

  /**
   * Save conversation turn to Redis
   * ATOMIC operation to prevent race conditions
   *
   * @param {string} userId - User ID
   * @param {string} sessionId - Session ID
   * @param {string} userMessage - Complete user message (NOT partial/streaming)
   * @param {string} aiResponse - Complete AI response (NOT partial/streaming)
   * @param {number|string} ttl - TTL in seconds (default from env)
   * @returns {Promise<{success: boolean, totalTurns: number, turnId: string}>}
   */
  static async saveConversationTurn(
    userId,
    sessionId,
    userMessage,
    aiResponse,
    ttl = env.shortTermMemoryTTL,
    metadata = {}
  ) {
    try {
      const client = await redisService.getRedisClient();
      if (!client) {
        throw new RedisConnectionError('Redis client not initialized');
      }

      const conversationTurnId = metadata.conversationTurnId;
      const idempotencyKey = conversationTurnId
        ? `memory:turn:event:${String(userId)}:${String(conversationTurnId)}`
        : null;
      if (idempotencyKey) {
        const claimed = await client.set(idempotencyKey, JSON.stringify({ status: 'processing' }), { NX: true, EX: INACTIVE_KEY_TTL_SECONDS });
        if (claimed !== 'OK') {
          const existing = await client.get(idempotencyKey);
          const parsed = existing ? JSON.parse(existing) : {};
          return { success: true, duplicate: true, totalTurns: parsed.totalTurns || 0, turnId: parsed.turnId || null };
        }
      }

      const key = this.buildKey(userId);
      const existingTurnsCount = await client.lLen(key);

      const normalizedUserMessage = this.normalizeMessage(userMessage);
      const normalizedAssistantMessage = this.normalizeMessage(aiResponse);
      const timestamp = new Date().toISOString();
      const turnId = this.generateTurnId();

      const payload = this.serializeStoredTurn({
        timestamp,
        userMessage: normalizedUserMessage,
        assistantMessage: normalizedAssistantMessage,
      });

      // Capture raw list before push to compute exact compression metrics
      let rawBefore = [];
      try {
        rawBefore = await client.lRange(key, 0, -1);
      } catch (e) {
        rawBefore = [];
      }

      const multi = this.createRedisPipeline(client);
      multi.rPush(key, payload);
      multi.expire(key, INACTIVE_KEY_TTL_SECONDS);

      const start = Date.now();
      const results = await this.executeRedisPipeline(multi, { userId, sessionId });
      const saveDurationMs = Date.now() - start;


      if (!results || results.length < 2) {
        throw new RedisConnectionError('Pipeline execution failed');
      }

      let cleanupCount = 0;
      try {
        cleanupCount = await this.cleanupExpiredTurns(client, key);
      } catch (cleanupError) {
      }

      const totalTurns = await client.lLen(key);

      if (idempotencyKey) {
        await client.set(idempotencyKey, JSON.stringify({ status: 'completed', totalTurns, turnId }), { EX: INACTIVE_KEY_TTL_SECONDS });
      }

      // Compression telemetry: measure characters before/after and report
      try {
        const rawList = await client.lRange(key, 0, -1);
        const charsAfter = rawList.map((r) => String(r).length).reduce((a, b) => a + b, 0);
        const charsBefore = rawBefore.map((r) => String(r).length).reduce((a, b) => a + b, 0);
        const ratio = charsBefore > 0 ? (charsAfter / charsBefore) : 1;
        const avgCharsPerTurn = totalTurns > 0 ? Math.round(charsAfter / totalTurns) : 0;
        const currentTtl = await client.ttl(key);
      } catch (obsErr) {
      }

      // Persist to Mongo (backup)
      try {
        await ConversationTurn.create({
          userId,
          sessionId,
          userMessage,
          assistantResponse: aiResponse,
          timestamp,
          raw: {
            userMessage,
            assistantResponse: aiResponse,
            sessionId,
            timestamp,
          },
        });
      } catch (mongoError) {
      }

    try {
      await this.enqueuePromotionCandidate(userId);
    } catch (queueError) {
    }

      return {
        success: true,
        totalTurns,
        turnId,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Retrieve recent memory for user.
   * Returns every valid turn whose timestamp is within the configured time window.
   * Optional fields such as conversationId/sessionId do not cause rejection.
   * @param {string} userId - User ID
   * @returns {Promise<Array>} Array of conversation turns
   */
  static async cleanupExpiredTurns(client, key) {
    const cutoff = Date.now() - MEMORY_SLIDING_WINDOW_MS;
    let removedCount = 0;

    while (true) {
      const oldest = await client.lIndex(key, 0);
      if (!oldest) {
        break;
      }

      const parsed = this.parseStoredTurn(oldest);
      if (!parsed) {
        await client.lPop(key);
        removedCount += 1;
        continue;
      }

      const timestampValue = parsed.timestamp ? Date.parse(parsed.timestamp) : NaN;
      if (!Number.isFinite(timestampValue) || timestampValue < cutoff) {
        await client.lPop(key);
        removedCount += 1;
        continue;
      }
      break;
    }

    return removedCount;
  }

  static async getRecentMemory(userId) {
    try {
      const client = await redisService.getRedisClient();
      if (!client) {
        throw new RedisConnectionError('Redis client not initialized');
      }

      const key = this.buildKey(userId);
      const data = await client.lRange(key, 0, -1);

      if (!data || data.length === 0) {
        return [];
      }

      const cutoff = Date.now() - MEMORY_SLIDING_WINDOW_MS;
      const selected = [];

      for (const item of data) {
        try {
          const parsed = this.parseStoredTurn(item);
          if (!parsed) {
            continue;
          }

          const timestampValue = parsed.timestamp ? Date.parse(parsed.timestamp) : NaN;
          const userMessage = String(parsed.userMessage || '').trim();
          const assistantMessage = String(parsed.assistantMessage || '').trim();

          if (!userMessage || !assistantMessage) {
            continue;
          }
          if (!Number.isFinite(timestampValue)) {
            continue;
          }
          if (timestampValue < cutoff) {
            continue;
          }

          selected.push({
            timestamp: new Date(timestampValue).toISOString(),
            userMessage,
            assistantMessage,
          });
        } catch (error) {
          continue;
        }
      }

      return selected;
    } catch (error) {
      throw error;
    }
  }

  static async enqueuePromotionCandidate(userId) {
    if (!userId) {
      return false;
    }

    try {
      const client = await redisService.getRedisClient();
      if (!client) {
        throw new RedisConnectionError('Redis client not initialized');
      }

      const queueKey = this.buildPromotionQueueKey();
      const metaKey = this.buildPromotionMetaKey(userId);
      const now = Date.now();
      const existingMeta = await client.hGetAll(metaKey);
      const lastPromotion = Number(existingMeta.lastPromotion || 0) || 0;
      const dueAt = Math.max(now, lastPromotion + PROMOTION_INTERVAL_MS);

      const payload = this.buildHashEntries({
        userId: String(userId),
        lastActivity: String(now),
        lastPromotion: String(lastPromotion),
        queuedAt: existingMeta.queuedAt || String(now),
        dueAt: String(dueAt),
        retryCount: existingMeta.retryCount || '0',
        lastError: existingMeta.lastError || '',
      });
      const ops = this.createRedisPipeline(client);
      if (payload.length) {
        ops.hSet(metaKey, ...payload);
      }
      ops.expire(metaKey, PROMOTION_QUEUE_TTL_SECONDS);
      ops.zAdd(queueKey, [{ score: dueAt, value: String(userId) }]);
      ops.expire(queueKey, PROMOTION_QUEUE_TTL_SECONDS);
      await this.executeRedisPipeline(ops, { userId });

      return true;
    } catch (error) {
      return false;
    }
  }

  static async getPromotionCandidates(limit = 20) {
    try {
      const client = await redisService.getRedisClient();
      if (!client) {
        throw new RedisConnectionError('Redis client not initialized');
      }

      const queueKey = this.buildPromotionQueueKey();
      const count = Number.isInteger(limit) && limit > 0 ? limit : 1;
      const members = await client.zRangeByScore(queueKey, 0, Date.now(), {
        LIMIT: {
          offset: 0,
          count,
        },
      });
      if (!members || members.length === 0) {
        return [];
      }
      return members.slice(0, count).map(String);
    } catch (error) {
      return [];
    }
  }

  static async removePromotionCandidate(userId) {
    if (!userId) {
      return false;
    }

    try {
      const client = await redisService.getRedisClient();
      if (!client) {
        throw new RedisConnectionError('Redis client not initialized');
      }

      const queueKey = this.buildPromotionQueueKey();
      await client.zRem(queueKey, String(userId));
      return true;
    } catch (error) {
      return false;
    }
  }

  static async getPromotionState(userId) {
    if (!userId) {
      return null;
    }

    try {
      const client = await redisService.getRedisClient();
      if (!client) {
        throw new RedisConnectionError('Redis client not initialized');
      }

      const meta = await client.hGetAll(this.buildPromotionMetaKey(userId));
      const lastActivity = Number(meta.lastActivity || 0) || 0;
      const lastPromotion = Number(meta.lastPromotion || 0) || 0;
      const retryCount = Number(meta.retryCount || 0) || 0;
      const dueAt = Number(meta.dueAt || 0) || 0;

      return {
        userId: String(meta.userId || userId),
        lastActivity,
        lastPromotion,
        retryCount,
        dueAt,
        lastError: meta.lastError || '',
      };
    } catch (error) {
      return null;
    }
  }

  static async deferPromotionCandidate(userId, dueAt) {
    if (!userId) {
      return false;
    }

    try {
      const client = await redisService.getRedisClient();
      if (!client) {
        throw new RedisConnectionError('Redis client not initialized');
      }

      const safeDueAt = Number.isFinite(Number(dueAt)) ? Number(dueAt) : Date.now() + PROMOTION_INTERVAL_MS;
      const ops = this.createRedisPipeline(client);
      ops.hSet(this.buildPromotionMetaKey(userId), 'dueAt', String(safeDueAt));
      ops.zAdd(this.buildPromotionQueueKey(), [{ score: safeDueAt, value: String(userId) }]);
      await this.executeRedisPipeline(ops, { userId });
      return true;
    } catch (error) {
      return false;
    }
  }

  static async recordPromotionSuccess(userId) {
    if (!userId) {
      return false;
    }

    try {
      const client = await redisService.getRedisClient();
      if (!client) {
        throw new RedisConnectionError('Redis client not initialized');
      }

      const payload = this.buildHashEntries({
        lastPromotion: String(Date.now()),
        retryCount: '0',
        lastError: '',
      });
      const ops = this.createRedisPipeline(client);
      if (payload.length) {
        ops.hSet(this.buildPromotionMetaKey(userId), ...payload);
      }
      ops.zRem(this.buildPromotionQueueKey(), String(userId));
      await this.executeRedisPipeline(ops, { userId });
      return true;
    } catch (error) {
      return false;
    }
  }

  static async recordPromotionFailure(userId, error) {
    if (!userId) {
      return false;
    }

    try {
      const client = await redisService.getRedisClient();
      if (!client) {
        throw new RedisConnectionError('Redis client not initialized');
      }

      const state = await this.getPromotionState(userId);
      const retryCount = (state?.retryCount || 0) + 1;
      const backoffMs = Math.min(PROMOTION_RETRY_BASE_MS * (2 ** Math.min(retryCount - 1, 8)), PROMOTION_RETRY_MAX_MS);
      const dueAt = Date.now() + backoffMs;
      const message = error instanceof Error ? error.message : String(error || 'unknown');

      const payload = this.buildHashEntries({
        retryCount: String(retryCount),
        lastError: message.slice(0, 300),
        dueAt: String(dueAt),
      });
      const ops = this.createRedisPipeline(client);
      if (payload.length) {
        ops.hSet(this.buildPromotionMetaKey(userId), ...payload);
      }
      ops.zAdd(this.buildPromotionQueueKey(), [{ score: dueAt, value: String(userId) }]);
      await this.executeRedisPipeline(ops, { userId });

      return true;
    } catch (redisError) {
      return false;
    }
  }

  static async alreadyPromotedEpisode(userId, episodeId) {
    if (!userId || !episodeId) {
      return false;
    }

    try {
      const client = await redisService.getRedisClient();
      if (!client) {
        throw new RedisConnectionError('Redis client not initialized');
      }

      return Boolean(await client.sIsMember(this.buildPromotedEpisodesKey(userId), episodeId));
    } catch (error) {
      return false;
    }
  }

  static async markEpisodePromoted(userId, episodeId) {
    if (!userId || !episodeId) {
      return false;
    }

    try {
      const client = await redisService.getRedisClient();
      if (!client) {
        throw new RedisConnectionError('Redis client not initialized');
      }

      // Link episodes for chaining: set previous -> next and update promotion meta
      const promoMetaKey = this.buildPromotionMetaKey(userId);
      const prevEpisode = (await client.hGet(promoMetaKey, 'lastPromotedEpisodeId')) || null;
      const ops = this.createRedisPipeline(client);
      ops.sAdd(this.buildPromotedEpisodesKey(userId), episodeId);
      ops.expire(this.buildPromotedEpisodesKey(userId), PROMOTION_QUEUE_TTL_SECONDS);
      // store episode link record
      const episodeLinkKey = this.buildEpisodeLinkKey(episodeId);
      ops.hSet(episodeLinkKey, 'episodeId', episodeId, 'createdAt', String(Date.now()));
      ops.expire(episodeLinkKey, PROMOTION_QUEUE_TTL_SECONDS);
      if (prevEpisode) {
        const prevLinkKey = this.buildEpisodeLinkKey(prevEpisode);
        // set prev.next = episodeId and episode.prev = prevEpisode
        ops.hSet(prevLinkKey, 'nextEpisodeId', episodeId);
        ops.hSet(episodeLinkKey, 'prevEpisodeId', prevEpisode);
        // mark that an episode chain was used
      }
      // update promotion meta lastPromotedEpisodeId
      ops.hSet(promoMetaKey, 'lastPromotedEpisodeId', episodeId, 'lastPromotion', String(Date.now()));
      await this.executeRedisPipeline(ops, { userId });
      return true;
    } catch (error) {
      return false;
    }
  }

  static buildEpisodeLinkKey(episodeId) {
    return `memory:episode:links:${episodeId}`;
  }

  // Memory stats: access frequency, importance, confidence, retrievalPriority
  static buildMemoryStatsKey(memoryId) {
    return `memory:stats:${memoryId}`;
  }

  static async getMemoryStats(memoryId) {
    if (!memoryId) return null;
    try {
      const client = await redisService.getRedisClient();
      if (!client) throw new RedisConnectionError('Redis client not initialized');
      const raw = await client.hGetAll(this.buildMemoryStatsKey(memoryId));
      if (!raw || Object.keys(raw).length === 0) return null;
      return {
        memoryId,
        accessFrequency: Number(raw.accessFrequency || 0),
        importance: Number(raw.importance || 0),
        confidence: Number(raw.confidence || 0),
        retrievalPriority: Number(raw.retrievalPriority || 0),
        lastAccessedAt: raw.lastAccessedAt || null,
      };
    } catch (err) {
      return null;
    }
  }

  static async incrementMemoryAccess(memoryId, deltas = {}) {
    if (!memoryId) return false;
    try {
      const client = await redisService.getRedisClient();
      if (!client) throw new RedisConnectionError('Redis client not initialized');
      const key = this.buildMemoryStatsKey(memoryId);
      const accessInc = Number(deltas.accessFrequency || 1);
      const impDelta = Number(deltas.importanceDelta || 0);
      const confDelta = Number(deltas.confidenceDelta || 0);
      const now = new Date().toISOString();
      // Use HINCRBYFLOAT for importance/confidence if supported; fallback to read-modify-write
      const current = await client.hGetAll(key) || {};
      const newImportance = Number(current.importance || 0) + impDelta;
      const newConfidence = Number(current.confidence || 0) + confDelta;
      const newAccess = Number(current.accessFrequency || 0) + accessInc;
      const multi = this.createRedisPipeline(client);
      multi.hSet(key, 'accessFrequency', String(newAccess), 'importance', String(Math.max(0, newImportance)), 'confidence', String(Math.max(0, newConfidence)), 'lastAccessedAt', now);
      await this.executeRedisPipeline(multi, { memoryId });
      return true;
    } catch (err) {
      return false;
    }
  }

  static async setMemoryStats(memoryId, stats = {}) {
    if (!memoryId) return false;
    try {
      const client = await redisService.getRedisClient();
      if (!client) throw new RedisConnectionError('Redis client not initialized');
      const key = this.buildMemoryStatsKey(memoryId);
      const payload = {};
      if (typeof stats.accessFrequency !== 'undefined') payload.accessFrequency = String(Number(stats.accessFrequency || 0));
      if (typeof stats.importance !== 'undefined') payload.importance = String(Number(stats.importance || 0));
      if (typeof stats.confidence !== 'undefined') payload.confidence = String(Number(stats.confidence || 0));
      if (typeof stats.retrievalPriority !== 'undefined') payload.retrievalPriority = String(Number(stats.retrievalPriority || 0));
      if (!Object.keys(payload).length) return false;
      payload.lastAccessedAt = stats.lastAccessedAt || new Date().toISOString();
      if (typeof stats.createdAt !== 'undefined') payload.createdAt = String(stats.createdAt || new Date().toISOString());
      if (typeof stats.memoryType !== 'undefined') payload.memoryType = String(stats.memoryType || 'episode');
      const flatValues = this.buildHashEntries(payload);
      if (!flatValues.length) return false;
      await client.hSet(key, ...flatValues);
      return true;
    } catch (err) {
      return false;
    }
  }

  // Apply decay across memory stats keys. Non-blocking; intended to be run periodically.
  static async applyDecay({ maxKeys = 1000, now = Date.now(), decayBase = 0.02 } = {}) {
    try {
      const client = await redisService.getRedisClient();
      if (!client) throw new RedisConnectionError('Redis client not initialized');
      const iterator = client.scanIterator({ MATCH: 'memory:stats:*', COUNT: 200 });
      let processed = 0;
      const summary = { processed: 0, skipped: 0, updated: 0 };
      for await (const key of iterator) {
        if (processed >= maxKeys) break;
        processed += 1;
        try {
          const raw = await client.hGetAll(key);
          const memoryId = key.replace('memory:stats:', '');
          const memoryType = raw.memoryType || 'episode';
          if (['identity', 'relationships', 'goals', 'preferences', 'permanent', 'project_active'].includes(memoryType)) {
            summary.skipped += 1;
            continue;
          }
          const importance = Number(raw.importance || 0);
          const confidence = Number(raw.confidence || 0);
          const accessFrequency = Number(raw.accessFrequency || 0);
          const createdAt = raw.createdAt ? Number(new Date(String(raw.createdAt)).getTime()) : null;
          const lastAccessedAt = raw.lastAccessedAt ? Number(new Date(String(raw.lastAccessedAt)).getTime()) : null;
          const ageMs = createdAt ? (now - createdAt) : (lastAccessedAt ? (now - lastAccessedAt) : 0);
          const ageDays = ageMs > 0 ? (ageMs / (1000 * 60 * 60 * 24)) : 0;

          // Compute decay scale: older and low-quality memories decay faster
          const ageFactor = Math.min(1, ageDays / 365); // 0..1
          const freqFactor = 1 - Math.tanh(accessFrequency / 20); // high freq -> lower decay
          const quality = (importance * 0.6) + (confidence * 0.4);
          const qualityFactor = 1 - quality; // low quality => higher decay
          const decayAmount = decayBase * ageFactor * freqFactor * qualityFactor;

          // Ensure old important memories decay very slowly
          const minImportance = 0.01;
          const newImportance = Math.max(minImportance, Math.max(0, importance - decayAmount));
          const newRetrievalPriority = Math.max(0, (newImportance * 0.75) + (confidence * 0.25));

          // Update only if meaningful change
          if (Math.abs(newImportance - importance) > 1e-6) {
            await client.hSet(
              key,
              'importance', String(Number(newImportance.toFixed(4))),
              'retrievalPriority', String(Number(newRetrievalPriority.toFixed(4)))
            );
            summary.updated += 1;
          } else {
            summary.skipped += 1;
          }
        } catch (inner) {
        }
      }
      summary.processed = processed;
      return summary;
    } catch (err) {
      return { processed: 0, skipped: 0, updated: 0 };
    }
  }

  static async upsertSemanticMemories(userId, semanticMemories, options = {}) {
    if (!userId || !semanticMemories || typeof semanticMemories !== 'object') {
      return 0;
    }

    const source = this.normalizeSource(options.source || 'unknown');
    const turnId = options.turnId || null;

    try {
      const client = await redisService.getRedisClient();
      if (!client) {
        throw new RedisConnectionError('Redis client not initialized');
      }

      const semanticKey = this.buildSemanticMemoryKey(userId);
      const semanticLock = await acquireSemanticWriteLock(client, userId);
      try {
      const existingRaw = await client.hGetAll(semanticKey);
      const existingEntries = {};
      for (const [hashKey, rawValue] of Object.entries(existingRaw || {})) {
        try {
          const parsed = JSON.parse(rawValue);
          if (parsed && typeof parsed === 'object') {
            existingEntries[hashKey] = parsed;
          }
        } catch {
          // ignore malformed existing entry
        }
      }

      const mergedEntries = { ...existingEntries };
      const activeLogicalEntries = new Map();
      for (const [entryHash, existing] of Object.entries(mergedEntries)) {
        if (!existing || typeof existing !== 'object') continue;
        if (this.normalizeStatus(existing.status || 'active') !== 'active') continue;
        const logicalKey = this.getLogicalMemoryKey(existing);
        if (!activeLogicalEntries.has(logicalKey)) {
          activeLogicalEntries.set(logicalKey, { entryHash, entry: existing });
        }
      }

      const staleRedisFields = new Set();
      const insertedKeys = new Set();
      const canonicalChangedKeys = new Set();

      for (const [category, items] of Object.entries(semanticMemories)) {
        if (!Array.isArray(items)) continue;

        for (const item of items) {
          if (!item?.key || !item?.value) continue;

          const normalizedItem = {
            ...item,
            category,
            source: this.normalizeSource(item.source || source),
            userOwned: item.userOwned === true || item.user_owned === true || this.normalizeSource(item.source || source) === 'user',
            memoryWorthy: item.memoryWorthy !== false,
            confidenceScore: Number.isFinite(Number(item.confidenceScore || item.confidence))
              ? Number(item.confidenceScore || item.confidence)
              : 0.8,
            status: this.normalizeStatus(item.status || 'active'),
            attribute: item.attribute || item.key,
            turnId: turnId || item.source_turn_ids?.[0] || item.turnId || null,
            updatedAt: new Date().toISOString(),
            createdAt: item.createdAt || new Date().toISOString(),
            logicalKey: null,
          };

          normalizedItem.logicalKey = this.getLogicalMemoryKey(normalizedItem);
          normalizedItem.id = normalizedItem.id || `semantic:${category}:${String(normalizedItem.attribute || normalizedItem.key || 'memory').toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 64)}`;
          normalizedItem.memoryId = normalizedItem.memoryId || normalizedItem.id;
          normalizedItem.parentMemoryId = normalizedItem.parentMemoryId || null;
          normalizedItem.supersedesMemoryId = normalizedItem.supersedesMemoryId || null;
          const logicalKey = normalizedItem.logicalKey;
          const currentActive = activeLogicalEntries.get(logicalKey);
          const currentValue = currentActive ? String(currentActive.entry.value || '').trim().toLowerCase() : null;
          const candidateValue = String(normalizedItem.value || '').trim().toLowerCase();

          if (['assistant', 'unknown'].includes(normalizedItem.source)) {
            const activeParent = currentActive || Object.entries(mergedEntries)
              .map(([entryHash, entry]) => ({ entryHash, entry }))
              .find(({ entry }) => entry && this.getLogicalMemoryKey(entry) === logicalKey && this.normalizeStatus(entry.status || 'active') === 'active');
            const rejectionReason = activeParent
              ? 'lower_authority_than_active'
              : (normalizedItem.source === 'assistant'
                ? 'assistant_output_is_not_user_asserted_truth'
                : 'missing_source_authority');
            const rejectedHashKey = `${logicalKey}:rejected:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
            mergedEntries[rejectedHashKey] = {
              ...normalizedItem,
              status: 'rejected',
              reason: rejectionReason,
              rejectionReason,
              parentMemoryId: activeParent?.entry.memoryId || activeParent?.entry.id || activeParent?.entryHash || null,
              rejectedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            insertedKeys.add(rejectedHashKey);
            continue;
          }

          const candidateIdAlreadyExists = Object.values(mergedEntries).some((entry) => {
            if (!entry || typeof entry !== 'object') return false;
            return (entry.memoryId || entry.id) === normalizedItem.memoryId;
          });
          if (currentActive && currentValue !== candidateValue && candidateIdAlreadyExists) {
            normalizedItem.id = buildSemanticVersionId(logicalKey);
            normalizedItem.memoryId = normalizedItem.id;
          }

          if (currentActive && currentValue === candidateValue) {
            const activeEntry = {
              ...currentActive.entry,
              ...normalizedItem,
              status: 'active',
              memoryId: currentActive.entry.memoryId || currentActive.entry.id || normalizedItem.memoryId,
              parentMemoryId: currentActive.entry.parentMemoryId || null,
              supersedesMemoryId: currentActive.entry.supersedesMemoryId || null,
              updatedAt: new Date().toISOString(),
            };
            this.removeLogicalKeyEntries(mergedEntries, logicalKey);
            mergedEntries[logicalKey] = activeEntry;
            activeLogicalEntries.set(logicalKey, { entryHash: logicalKey, entry: activeEntry });
            insertedKeys.add(logicalKey);
            continue;
          }

          if (currentActive) {
            const existing = currentActive.entry;
            const existingSourcePriority = this.getSourcePriority(existing.source || 'unknown');
            const candidateSourcePriority = this.getSourcePriority(normalizedItem.source || 'unknown');
            const existingConfidence = Number(existing.confidenceScore || existing.confidence || 0);
            const candidateConfidence = Number(normalizedItem.confidenceScore || normalizedItem.confidence || 0);
            const sameSource = this.normalizeSource(existing.source || 'unknown') === this.normalizeSource(normalizedItem.source || 'unknown');
            const logicalKeyCorrection = currentValue !== candidateValue && sameSource && this.getLogicalMemoryKey(existing) === this.getLogicalMemoryKey(normalizedItem);
            const shouldReplace = currentValue !== candidateValue && (
              logicalKeyCorrection ||
              candidateSourcePriority > existingSourcePriority ||
              (candidateSourcePriority === existingSourcePriority && sameSource && candidateConfidence >= existingConfidence)
            );

            if (shouldReplace) {
              const staleActiveHashKeys = [];
              for (const [hashKey, entry] of Object.entries(mergedEntries)) {
                if (!entry || typeof entry !== 'object') continue;
                if (this.getLogicalMemoryKey(entry) === logicalKey && this.normalizeStatus(entry.status || 'active') === 'active') {
                  staleActiveHashKeys.push(hashKey);
                }
              }

              for (const staleHashKey of staleActiveHashKeys) {
                const staleEntry = mergedEntries[staleHashKey];
                if (!staleEntry || typeof staleEntry !== 'object') continue;
                const supersededHashKey = `${logicalKey}:superseded:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
                const superseded = {
                  ...staleEntry,
                  status: 'superseded',
                  memoryId: staleEntry.memoryId || staleEntry.id || staleHashKey,
                  updatedAt: new Date().toISOString(),
                  supersededAt: new Date().toISOString(),
                  previousVersion: staleEntry.previousVersion || staleEntry.id || null,
                  replacedBy: normalizedItem.memoryId || normalizedItem.id || logicalKey,
                  supersededBy: normalizedItem.memoryId || normalizedItem.id || logicalKey,
                };
                mergedEntries[supersededHashKey] = superseded;
                delete mergedEntries[staleHashKey];
              }

              normalizedItem.status = 'active';
              normalizedItem.attribute = normalizedItem.attribute || normalizedItem.key;
              normalizedItem.source = this.normalizeSource(normalizedItem.source || source);
              normalizedItem.turnId = turnId || normalizedItem.turnId || normalizedItem.source_turn_ids?.[0] || null;
              normalizedItem.memoryId = normalizedItem.memoryId || normalizedItem.id;
              normalizedItem.supersedesMemoryId = existing.memoryId || existing.id || currentActive.entryHash;
              normalizedItem.parentMemoryId = null;

              mergedEntries[logicalKey] = normalizedItem;
              activeLogicalEntries.set(logicalKey, { entryHash: logicalKey, entry: normalizedItem });
              insertedKeys.add(logicalKey);
              canonicalChangedKeys.add(logicalKey);
              continue;
            }

            const rejectedEntry = {
              ...normalizedItem,
              logicalKey,
              status: 'rejected',
              reason: 'lower_authority_than_active',
              rejectionReason: 'lower_authority_than_active',
              parentMemoryId: currentActive?.entry.memoryId || currentActive?.entry.id || currentActive?.entryHash || null,
              rejectedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              source: this.normalizeSource(normalizedItem.source || source),
            };
            const rejectedHashKey = `${logicalKey}:rejected:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
            mergedEntries[rejectedHashKey] = rejectedEntry;
            insertedKeys.add(rejectedHashKey);
            continue;
          }

          normalizedItem.status = 'active';
          normalizedItem.attribute = normalizedItem.attribute || normalizedItem.key;
          normalizedItem.source = this.normalizeSource(normalizedItem.source || source);
          normalizedItem.turnId = turnId || normalizedItem.turnId || normalizedItem.source_turn_ids?.[0] || null;
          normalizedItem.memoryId = normalizedItem.memoryId || normalizedItem.id;

          mergedEntries[logicalKey] = normalizedItem;
          activeLogicalEntries.set(logicalKey, { entryHash: logicalKey, entry: normalizedItem });
          insertedKeys.add(logicalKey);
          canonicalChangedKeys.add(logicalKey);
        }
      }

      if (!insertedKeys.size && !Object.keys(mergedEntries).length) {
        return 0;
      }

      const serializedEntries = Object.fromEntries(
        Object.entries(mergedEntries).map(([key, value]) => [key, JSON.stringify(value)])
      );

      const ops = this.createRedisPipeline(client);
      for (const staleKey of staleRedisFields) {
        if (staleKey) {
          ops.hDel(semanticKey, staleKey);
        }
      }
      if (Object.keys(serializedEntries).length) {
        ops.hSet(semanticKey, serializedEntries);
      }
      ops.expire(semanticKey, PROMOTION_QUEUE_TTL_SECONDS);
      await this.executeRedisPipeline(ops, { userId });

      if (canonicalChangedKeys.size) {
        await client.incr(this.buildSemanticMemoryRevisionKey(userId));
      }

      return insertedKeys.size || Object.keys(mergedEntries).length;
      } finally {
        await releaseSemanticWriteLock(client, semanticLock);
      }
    } catch (error) {
      return 0;
    }
  }

  static async cleanupRejectedSemanticMemories(userId = null) {
    try {
      const client = await redisService.getRedisClient();
      if (!client) {
        throw new RedisConnectionError('Redis client not initialized');
      }

      const keys = userId ? [this.buildSemanticMemoryKey(userId)] : [];
      if (!keys.length) {
        const iterator = client.scanIterator ? client.scanIterator({ MATCH: 'memory:longterm:semantic:*', COUNT: 200 }) : null;
        for await (const key of iterator || []) {
          keys.push(key);
        }
      }

      let inspected = 0;
      let removed = 0;
      const now = Date.now();
      const retentionMs = this.getRejectedMemoryRetentionSeconds() * 1000;

      for (const semanticKey of keys) {
        if (typeof client.type === 'function' && (await client.type(semanticKey)) !== 'hash') {
          continue;
        }
        const raw = await client.hGetAll(semanticKey);
        for (const [hashKey, rawValue] of Object.entries(raw || {})) {
          inspected += 1;
          try {
            const entry = JSON.parse(rawValue);
            if (!entry || typeof entry !== 'object') continue;
            if (this.normalizeStatus(entry.status || 'active') !== 'rejected') continue;
            const rejectedAt = entry.rejectedAt ? new Date(entry.rejectedAt).getTime() : null;
            if (!Number.isFinite(rejectedAt)) continue;
            if (now - rejectedAt >= retentionMs) {
              await client.hDel(semanticKey, hashKey);
              removed += 1;
            }
          } catch {
            continue;
          }
        }
      }

      return { inspected, removed };
    } catch (err) {
      return { inspected: 0, removed: 0, error: err.message || String(err) };
    }
  }

  static startRejectedMemoryCleanupScheduler() {
    if (rejectedMemoryCleanupTimer) {
      return rejectedMemoryCleanupTimer;
    }

    rejectedMemoryCleanupTimer = setInterval(() => {
      this.cleanupRejectedSemanticMemories().catch((err) => {
      });
    }, this.getRejectedMemoryCleanupIntervalMs());

    return rejectedMemoryCleanupTimer;
  }

  static stopRejectedMemoryCleanupScheduler() {
    if (rejectedMemoryCleanupTimer) {
      clearInterval(rejectedMemoryCleanupTimer);
      rejectedMemoryCleanupTimer = null;
    }
  }

  // Relationship management: store per-user relationship hashes under memory:relationships:user:{userId}
  static buildRelationshipKey(userId) {
    return `memory:relationships:user:${userId}`;
  }

  static async upsertRelationship(userId, personName, rel = {}) {
    if (!userId || !personName) return false;
    try {
      const client = await redisService.getRedisClient();
      if (!client) throw new RedisConnectionError('Redis client not initialized');
      const key = this.buildRelationshipKey(userId);
      const now = new Date().toISOString();
      const existingRaw = await client.hGet(key, personName);
      let existing = existingRaw ? JSON.parse(existingRaw) : null;
      const updated = Object.assign({}, existing || {}, rel || {});
      updated.personName = personName;
      updated.firstMention = updated.firstMention || now;
      updated.lastMention = now;
      updated.mentionCount = (Number(updated.mentionCount || 0) + 1);
      updated.importance = Number(updated.importance || rel.importance || 0) || 0;
      updated.sharedEvents = updated.sharedEvents || [];
      updated.projects = updated.projects || [];
      updated.relationshipType = updated.relationshipType || rel.relationshipType || 'unknown';
      updated.relationshipStrength = Number(updated.relationshipStrength || 0) + (rel.boost || 0.05);
      await client.hSet(key, personName, JSON.stringify(updated));
      await client.expire(key, PROMOTION_QUEUE_TTL_SECONDS);
      return true;
    } catch (err) {
      return false;
    }
  }

  static async getRelationships(userId) {
    if (!userId) return {};
    try {
      const client = await redisService.getRedisClient();
      if (!client) throw new RedisConnectionError('Redis client not initialized');
      const raw = await client.hGetAll(this.buildRelationshipKey(userId));
      const out = {};
      for (const [k, v] of Object.entries(raw || {})) {
        try { out[k] = JSON.parse(v); } catch { out[k] = null; }
      }
      return out;
    } catch (err) {
      return {};
    }
  }

  static async getSemanticMemories(userId) {
    if (!userId) {
      return {};
    }

    try {
      const client = await redisService.getRedisClient();
      if (!client) {
        throw new RedisConnectionError('Redis client not initialized');
      }

      const raw = await client.hGetAll(this.buildSemanticMemoryKey(userId));
      const currentByLogicalKey = new Map();
      for (const value of Object.values(raw || {})) {
        try {
          const item = JSON.parse(value);
          if (!item || typeof item !== 'object') continue;
          item.status = this.normalizeStatus(item.status || 'active');
          if (!this.isCurrentCanonicalMemory(item)) continue;
          const logicalKey = this.getLogicalMemoryKey(item);
          item.logicalKey = logicalKey;
          if (logicalKey === 'identity:name') {
            item.key = 'name';
            item.attribute = 'name';
          }
          const current = currentByLogicalKey.get(logicalKey);
          if (this.isPreferredActiveMemory(item, current)) {
            currentByLogicalKey.set(logicalKey, item);
          }
        } catch {
          // ignore malformed semantic entries
        }
      }

      const grouped = {};
      for (const item of currentByLogicalKey.values()) {
        const category = item.category || 'facts';
        if (!grouped[category]) grouped[category] = [];
        grouped[category].push(item);
      }

      for (const category of Object.keys(grouped)) {
        grouped[category].sort((a, b) => {
          const aUpdatedAt = Date.parse(a.updatedAt || a.createdAt || '') || 0;
          const bUpdatedAt = Date.parse(b.updatedAt || b.createdAt || '') || 0;
          return bUpdatedAt - aUpdatedAt;
        });
      }

      return grouped;
    } catch (error) {
      return {};
    }
  }

  static async deleteSemanticMemories(userId, criteria = []) {
    if (!userId) return 0;

    try {
      const client = await redisService.getRedisClient();
      if (!client) {
        throw new RedisConnectionError('Redis client not initialized');
      }

      const semanticKey = this.buildSemanticMemoryKey(userId);
      const raw = await client.hGetAll(semanticKey);
      if (!raw || !Object.keys(raw).length) {
        return 0;
      }

      const filters = Array.isArray(criteria) ? criteria : [criteria];
      let deleted = 0;

      for (const [hashKey, rawValue] of Object.entries(raw)) {
        try {
          const item = JSON.parse(rawValue);
          if (!item || typeof item !== 'object') continue;
          if (this.normalizeStatus(item.status || 'active') !== 'active') continue;

          let shouldDelete = false;
          for (const filter of filters) {
            if (!filter) continue;

            if (typeof filter === 'function') {
              if (filter(item)) {
                shouldDelete = true;
                break;
              }
              continue;
            }

            if (typeof filter === 'string') {
              const token = String(filter).trim().toLowerCase();
              if (!token) continue;
              const targetCategory = String(item.category || '').toLowerCase();
              const targetAttribute = String(item.attribute || item.key || '').toLowerCase();
              const targetValue = String(item.value || '').toLowerCase();
              if (targetCategory === token || targetAttribute === token || targetValue.includes(token)) {
                shouldDelete = true;
                break;
              }
              continue;
            }

            if (filter && typeof filter === 'object') {
              const categoryMatch = filter.category && String(item.category || '').toLowerCase() === String(filter.category).toLowerCase();
              const attributeMatch = filter.attribute && String(item.attribute || item.key || '').toLowerCase() === String(filter.attribute).toLowerCase();
              const valueMatch = filter.value && (
                String(item.value || '').toLowerCase().includes(String(filter.value).toLowerCase()) ||
                String(filter.value).toLowerCase().includes(String(item.value || '').toLowerCase())
              );
              if (categoryMatch || attributeMatch || valueMatch) {
                shouldDelete = true;
                break;
              }
            }
          }

          if (!shouldDelete) continue;

          const deletedAt = new Date().toISOString();
          const updated = {
            ...item,
            memoryId: item.memoryId || item.id || hashKey,
            status: 'deleted',
            deletedAt,
            updatedAt: deletedAt,
          };
          await client.hSet(semanticKey, hashKey, JSON.stringify(updated));
          deleted += 1;
        } catch {
          continue;
        }
      }

      if (deleted > 0) {
        await client.incr(this.buildSemanticMemoryRevisionKey(userId));
      }

      return deleted;
    } catch (error) {
      return 0;
    }
  }

  static async getMemoryLineage(userId, memoryId) {
    if (!userId || !memoryId) return null;

    try {
      const client = await redisService.getRedisClient();
      if (!client) throw new RedisConnectionError('Redis client not initialized');

      const raw = await client.hGetAll(this.buildSemanticMemoryKey(userId));
      const records = Object.entries(raw || {}).flatMap(([hashKey, value]) => {
        try {
          const item = JSON.parse(value);
          if (!item || typeof item !== 'object') return [];
          return [{ ...item, memoryId: item.memoryId || item.id || hashKey, _hashKey: hashKey }];
        } catch {
          return [];
        }
      });
      const target = records.find((item) => item.memoryId === String(memoryId) || item.id === String(memoryId));
      if (!target) return null;

      const related = new Map([[target._hashKey, target]]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const item of records) {
          const pointsToRelated = [item.parentMemoryId, item.supersedesMemoryId, item.supersededBy, item.replacedBy]
            .filter(Boolean)
            .some((id) => relatedHasMemoryId(related, id));
          const relatedPointsToItem = Array.from(related.values()).some((parent) =>
            [parent.parentMemoryId, parent.supersedesMemoryId, parent.supersededBy, parent.replacedBy]
              .filter(Boolean)
              .includes(item.memoryId)
          );
          if ((pointsToRelated || relatedPointsToItem) && !related.has(item._hashKey)) {
            related.set(item._hashKey, item);
            changed = true;
          }
        }
      }

      const chain = Array.from(related.values()).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      const active = chain
        .filter((item) => this.normalizeStatus(item.status || 'active') === 'active')
        .reduce((preferred, item) => this.isPreferredActiveMemory(item, preferred) ? item : preferred, null);
      return {
        userId: String(userId),
        memoryId: target.memoryId,
        logicalKey: target.logicalKey || this.getLogicalMemoryKey(target),
        activeMemoryId: active ? active.memoryId : null,
        records: chain.map(({ _hashKey, ...item }) => item),
      };
    } catch (error) {
      return null;
    }
  }

  static async getPromotionQueueMetrics() {
    try {
      const client = await redisService.getRedisClient();
      if (!client) {
        throw new RedisConnectionError('Redis client not initialized');
      }

      const queueKey = this.buildPromotionQueueKey();
      const now = Date.now();
      const [queuedUsers, dueUsers] = await Promise.all([
        client.zCard(queueKey),
        client.zCount(queueKey, 0, now),
      ]);

      return {
        queuedUsers,
        dueUsers,
        pendingRetries: queuedUsers,
      };
    } catch {
      return {
        queuedUsers: 0,
        dueUsers: 0,
        pendingRetries: 0,
      };
    }
  }
  /**
   * Delete all memory for user
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} Success status
   */
  static async deleteExpiredMemory(userId) {
    try {
      const client = await redisService.getRedisClient();
      if (!client) {
        throw new RedisConnectionError('Redis client not initialized');
      }

      const key = this.buildKey(userId);
      const result = await client.del(key);

      if (result > 0) {
        return true;
      }

      return false;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get memory size (number of turns)
   * @param {string} userId - User ID
   * @returns {Promise<number>} Number of conversation turns
   */
  static async getMemorySize(userId) {
    try {
      const client = await redisService.getRedisClient();
      if (!client) {
        throw new RedisConnectionError('Redis client not initialized');
      }

      const key = this.buildKey(userId);
      const size = await client.lLen(key);

      return size || 0;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get memory TTL
   * @param {string} userId - User ID
   * @returns {Promise<number>} TTL in seconds (-1 if no expiry, -2 if key doesn't exist)
   */
  static async getMemoryTTL(userId) {
    try {
      const client = await redisService.getRedisClient();
      if (!client) {
        throw new RedisConnectionError('Redis client not initialized');
      }

      const key = this.buildKey(userId);
      const ttl = await client.ttl(key);

      return ttl;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Check if Redis connection is alive
   * @returns {Promise<boolean>}
   */
  static async isHealthy() {
    try {
      const client = await redisService.getRedisClient();
      if (!client) return false;
      await client.ping();
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Generate unique turn ID
   * @returns {string} Unique turn ID
   */
  static generateTurnId() {
    return `turn_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }
}

module.exports = WorkingMemoryRedis;