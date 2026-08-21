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
const logger = require('../../utils/workingMemory/logger');

const MEMORY_SLIDING_WINDOW_MS = 20 * 60 * 1000; // 20 minutes
const INACTIVE_KEY_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const PROMOTION_INTERVAL_MS = 15 * 60 * 1000;
const PROMOTION_QUEUE_TTL_SECONDS = 7 * 24 * 60 * 60;
const PROMOTION_RETRY_BASE_MS = 60 * 1000;
const PROMOTION_RETRY_MAX_MS = 15 * 60 * 1000;

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
        logger.logError('REDIS_EXEC_ABORT', err.message, err.stack, context.userId || '', context.sessionId || '');
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
      console.info('[ENTERED] WorkingMemoryRedis.saveConversationTurn', { userId, sessionId, userMessageLength: userMessage?.length, aiResponseLength: aiResponse?.length, ttl });
      const client = await redisService.getRedisClient();
      if (!client) {
        console.info('[OUTPUT] WorkingMemoryRedis.saveConversationTurn', { result: 'no-redis-client' });
        throw new RedisConnectionError('Redis client not initialized');
      }

      const key = this.buildKey(userId);
      const existingTurnsCount = await client.lLen(key);
      console.info('[INPUT] WorkingMemoryRedis.saveConversationTurn', { key, existingTurnsCount });

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
      console.info('[RPUSH] payloadPreview', { key, payloadPreview: payload.slice(0, 300) });
      multi.rPush(key, payload);
      multi.expire(key, INACTIVE_KEY_TTL_SECONDS);

      const start = Date.now();
      const results = await this.executeRedisPipeline(multi, { userId, sessionId });
      const saveDurationMs = Date.now() - start;

      console.info('[RPUSH_RESULT] WorkingMemoryRedis.saveConversationTurn', { key, results, durationMs: saveDurationMs });

      if (!results || results.length < 2) {
        throw new RedisConnectionError('Pipeline execution failed');
      }

      let cleanupCount = 0;
      try {
        cleanupCount = await this.cleanupExpiredTurns(client, key);
      } catch (cleanupError) {
        logger.logError('STM_CLEANUP_ERROR', cleanupError.message || String(cleanupError), cleanupError.stack, userId, sessionId);
      }

      const totalTurns = await client.lLen(key);

      // Compression telemetry: measure characters before/after and report
      try {
        const rawList = await client.lRange(key, 0, -1);
        const charsAfter = rawList.map((r) => String(r).length).reduce((a, b) => a + b, 0);
        const charsBefore = rawBefore.map((r) => String(r).length).reduce((a, b) => a + b, 0);
        const ratio = charsBefore > 0 ? (charsAfter / charsBefore) : 1;
        const avgCharsPerTurn = totalTurns > 0 ? Math.round(charsAfter / totalTurns) : 0;
        const currentTtl = await client.ttl(key);
        console.info('[STM_COMPRESSION_METRICS]', JSON.stringify({ userId, existingTurnsCount, totalTurns, charsBefore, charsAfter, ratio: Number(ratio.toFixed(3)), avgCharsPerTurn, currentTtl, cleanupCount, ts: new Date().toISOString() }));
        logger.logShortTermMemory(userId, sessionId, key, existingTurnsCount, totalTurns, currentTtl, saveDurationMs, 'saved');
        console.info('[OUTPUT] WorkingMemoryRedis.saveConversationTurn', { turnId, totalTurns, cleanupCount, ttl: currentTtl });
      } catch (obsErr) {
        logger.logError('REDIS_OBSERVABILITY_ERROR', obsErr.message || String(obsErr), obsErr.stack, userId, sessionId);
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
        logger.logError(
          mongoError.name || 'MongoSaveError',
          mongoError.message || 'Failed to persist raw conversation turn to MongoDB',
          mongoError.stack,
          userId,
          sessionId
        );
      }

    try {
      await this.enqueuePromotionCandidate(userId);
    } catch (queueError) {
      logger.logError(
        queueError.name || 'PromotionQueueError',
        queueError.message || String(queueError),
        queueError.stack || null,
        userId,
        sessionId
      );
    }

      return {
        success: true,
        totalTurns,
        turnId,
      };
    } catch (error) {
      logger.logError(
        error.name,
        error.message,
        error.stack,
        userId,
        sessionId
      );
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
      logger.logError(error.name, error.message, error.stack, userId, '');
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
      logger.logError(error.name || 'RedisError', error.message || String(error), error.stack || null, userId, '');
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
      logger.logError(error.name || 'RedisError', error.message || String(error), error.stack || null, '', '');
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
      logger.logError(error.name || 'RedisError', error.message || String(error), error.stack || null, userId, '');
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
      logger.logError(error.name || 'RedisError', error.message || String(error), error.stack || null, userId, '');
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
      logger.logError(error.name || 'RedisError', error.message || String(error), error.stack || null, userId, '');
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
      logger.logError(error.name || 'RedisError', error.message || String(error), error.stack || null, userId, '');
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
      logger.logError(redisError.name || 'RedisError', redisError.message || String(redisError), redisError.stack || null, userId, '');
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
      logger.logError(error.name || 'RedisError', error.message || String(error), error.stack || null, userId, '');
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
      logger.logError(error.name || 'RedisError', error.message || String(error), error.stack || null, userId, '');
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
      logger.logError('MEMORY_STATS_GET_ERROR', err.message || String(err), err.stack || null, '', memoryId);
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
      logger.logError('MEMORY_STATS_INC_ERROR', err.message || String(err), err.stack || null, '', memoryId);
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
      logger.logError('MEMORY_STATS_SET_ERROR', err.message || String(err), err.stack || null, '', memoryId);
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
            logger.log('DECAY_APPLIED', { memoryId, oldImportance: importance, newImportance: Number(newImportance.toFixed(4)), ageDays: Number(ageDays.toFixed(1)) });
          } else {
            summary.skipped += 1;
          }
        } catch (inner) {
          logger.logError('DECAY_ENTRY_ERROR', inner.message || String(inner), inner.stack || null, '', key);
        }
      }
      summary.processed = processed;
      return summary;
    } catch (err) {
      logger.logError('DECAY_ERROR', err.message || String(err), err.stack || null, '', 'applyDecay');
      return { processed: 0, skipped: 0, updated: 0 };
    }
  }

  static async upsertSemanticMemories(userId, semanticMemories, options = {}) {
    if (!userId || !semanticMemories || typeof semanticMemories !== 'object') {
      return 0;
    }

    const source = options.source || 'unknown';
    const turnId = options.turnId || null;

    console.info('[UPSERT_SEMANTIC_DEBUG]', {
      userId,
      source,
      turnId,
      inputKeys: Object.keys(semanticMemories),
      inputDetail: Object.entries(semanticMemories).reduce((acc, [k, v]) => {
        acc[k] = Array.isArray(v) ? v.map(item => ({category: item?.category, key: item?.key, value: String(item?.value || '').slice(0,40), source: item?.source})) : 'not-array';
        return acc;
      }, {})
    });

    try {
      const client = await redisService.getRedisClient();
      if (!client) {
        throw new RedisConnectionError('Redis client not initialized');
      }

      const flattened = {};
      
      // CRITICAL: For identity memories, check existing confidence before overwriting
      for (const [category, items] of Object.entries(semanticMemories)) {
        if (!Array.isArray(items)) continue;
        
        for (const item of items) {
          if (!item?.key || !item?.value) continue;
          const fieldId = item.id || `${item.key}:${String(item.value).toLowerCase()}`;
          const safeFieldId = String(fieldId).replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 180);
          const hashKey = `${category}:${safeFieldId}`;

          // For identity category, check existing record's confidence
          if (category === 'identity') {
            const existingRaw = await client.hGet(this.buildSemanticMemoryKey(userId), hashKey);
            if (existingRaw) {
              const existing = JSON.parse(existingRaw);
              const newConfidence = Number(item.confidenceScore || 0.75);
              const existingConfidence = Number(existing.confidenceScore || 0.75);
              const newSource = item.source || 'unknown';
              const existingSource = existing.source || 'unknown';
              
              // If existing is from user and has high confidence, don't let lower-confidence AI text overwrite it
              if (existingSource === 'user' && existingConfidence >= 0.9 && newSource === 'assistant' && newConfidence < existingConfidence) {
                console.info('[IDENTITY_PROTECTION]', {
                  userId,
                  category,
                  key: item.key,
                  existingValue: existing.value,
                  rejectedValue: item.value,
                  existingSource,
                  existingConfidence,
                  newSource,
                  newConfidence,
                  reason: 'user_identity_protected_from_ai_overwrite'
                });
                continue;  // Skip this update
              }
            }
          }

          flattened[hashKey] = JSON.stringify({
            ...item,
            category,
            source: item.source || source,  // Use item source or fallback to parameter source
            turnId: turnId || item.source_turn_ids?.[0],
            updatedAt: new Date().toISOString(),
          });
        }
      }

      console.info('[UPSERT_FLATTENED_DEBUG]', {
        userId,
        flattenedKeys: Object.keys(flattened).slice(0, 5),
        flattenedSample: Object.entries(flattened)[0] ? {
          key: Object.keys(flattened)[0],
          value: JSON.parse(Object.values(flattened)[0])
        } : null
      });

      const entries = Object.entries(flattened);
      if (!entries.length) {
        return 0;
      }

      const flatValues = this.buildHashEntries(Object.fromEntries(entries));
      const ops = this.createRedisPipeline(client);
      ops.hSet(this.buildSemanticMemoryKey(userId), ...flatValues);
      ops.expire(this.buildSemanticMemoryKey(userId), PROMOTION_QUEUE_TTL_SECONDS);
      await this.executeRedisPipeline(ops, { userId });

      return entries.length;
    } catch (error) {
      logger.logError(error.name || 'RedisError', error.message || String(error), error.stack || null, userId, '');
      return 0;
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
      logger.logError('RELATIONSHIP_UPSERT_ERROR', err.message || String(err), err.stack || null, userId, personName);
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
      logger.logError('RELATIONSHIP_GET_ERROR', err.message || String(err), err.stack || null, userId, 'getRelationships');
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
      const grouped = {};
      for (const value of Object.values(raw || {})) {
        try {
          const item = JSON.parse(value);
          const category = item.category || 'facts';
          if (!grouped[category]) grouped[category] = [];
          grouped[category].push(item);
        } catch {
          // ignore malformed semantic entries
        }
      }

      return grouped;
    } catch (error) {
      logger.logError(error.name || 'RedisError', error.message || String(error), error.stack || null, userId, '');
      return {};
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
        logger.logMemoryDeleted(userId, 'all', key);
        return true;
      }

      return false;
    } catch (error) {
      logger.logError(error.name, error.message, error.stack, userId, '');
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
      logger.logError(error.name, error.message, error.stack, userId, '');
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
      logger.logError(error.name, error.message, error.stack, userId, '');
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
      logger.logError('REDIS_HEALTH_ERROR', String(error), error && error.stack ? error.stack : null, null, '');
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
