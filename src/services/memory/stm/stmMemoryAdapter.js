'use strict';

const { StmMemoryAdapterContract } = require('./stmMemoryAdapterContract');
const WorkingMemoryRedis = require('../../workingMemory/redisOperations');
const ConversationTurn = require('../../../models/ConversationTurn');
const { env } = require('../../../config/env');

const STM_WINDOW_MS = 20 * 60 * 1000;
const STOP_WORDS = new Set([
  'what', 'did', 'do', 'i', 'you', 'we', 'just', 'say', 'tell', 'me', 'about', 'the', 'a', 'an',
  'my', 'our', 'were', 'was', 'are', 'is', 'have', 'had', 'earlier', 'recently', 'now', 'today',
  'minutes', 'ago', 'please', 'remember', 'say', 'said', 'tell', 'told', 'discuss', 'discussing',
]);
const RECENT_UPDATE = /\b(switched|switching|no longer|don't use|do not use|stopped using|instead|now use|now prefer|changed to|moved to)\b/i;

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

function toTurnMemory(turn, userId, sessionId = null) {
  const userMessage = String(turn.userMessage || '').trim();
  const assistantMessage = String(turn.assistantMessage || turn.assistantResponse || turn.aiResponse || '').trim();
  return {
    id: turn.turnId || `stm:${turn.timestamp}:${normalizeText(userMessage).slice(0, 48)}`,
    userId,
    sessionId: turn.sessionId || sessionId || null,
    source: 'stm',
    retrievalSource: 'stm',
    type: 'recent_context',
    content: `User recently said: ${userMessage}${assistantMessage ? `\nKiara replied: ${assistantMessage}` : ''}`,
    userMessage,
    assistantMessage,
    timestamp: new Date(turn.timestamp).toISOString(),
    confidence: 1,
    importance: 0,
  };
}

function queryRelevant(turn, query, analysis) {
  const text = normalizeText(query);
  if (!text) return true;
  if (/\b(current|currently|right now|what do i .* prefer)\b/i.test(query)
    && RECENT_UPDATE.test(turn.userMessage || '')) {
    return true;
  }

  const keywords = [...(analysis?.keywords || [])]
    .map(normalizeText)
    .filter((word) => word && !STOP_WORDS.has(word));
  if (!keywords.length) return true;

  const haystack = normalizeText(`${turn.userMessage} ${turn.assistantMessage}`);
  return keywords.some((keyword) => haystack.includes(keyword));
}

function normalizeBackupTurn(turn) {
  const assistantMessage = turn.assistantResponse || turn.raw?.assistantResponse || '';
  return {
    timestamp: turn.timestamp ? new Date(turn.timestamp).toISOString() : null,
    userMessage: String(turn.userMessage || turn.raw?.userMessage || '').trim(),
    assistantMessage: String(assistantMessage).trim(),
  };
}

function turnKey(turn) {
  return turn.timestamp;
}

class StmMemoryAdapter extends StmMemoryAdapterContract {
  constructor({ redis = WorkingMemoryRedis, conversationTurnModel = ConversationTurn } = {}) {
    super();
    this.redis = redis;
    this.conversationTurnModel = conversationTurnModel;
  }

  async getRecentContext({ userId, sessionId = null, query = '', analysis = {}, options = {} } = {}) {
    const safeUserId = String(userId || '').trim();
    if (!safeUserId) {
      const error = new Error('userId is required for STM retrieval.');
      error.code = 'INVALID_USER_ID';
      throw error;
    }

    const startedAt = Date.now();
    const now = Date.now();
    const windowStart = new Date(now - STM_WINDOW_MS).toISOString();
    const windowEnd = new Date(now).toISOString();
    const limit = Math.min(Math.max(Number(options.limit) || 5, 1), 12);

    options.signal?.throwIfAborted();
    const storedTurns = await this.redis.getRecentMemory(safeUserId);
    options.signal?.throwIfAborted();
    const scopedTurns = Array.isArray(storedTurns) ? storedTurns : [];
    let sessionTurns = scopedTurns;

    if (sessionId) {
      const backupTurns = await this.conversationTurnModel.find({
        userId: safeUserId,
        sessionId: String(sessionId),
        timestamp: { $gte: new Date(windowStart), $lte: new Date(windowEnd) },
      }).select('userMessage assistantResponse timestamp')
        .sort({ timestamp: -1 })
        .maxTimeMS(env.memoryMongoQueryTimeoutMs)
        .lean();
      options.signal?.throwIfAborted();
      const allowed = new Set(backupTurns.map(normalizeBackupTurn).filter((turn) => turn.timestamp).map(turnKey));
      sessionTurns = scopedTurns.filter((turn) => allowed.has(turnKey({
        timestamp: turn.timestamp ? new Date(turn.timestamp).toISOString() : null,
        userMessage: turn.userMessage,
        assistantMessage: turn.assistantMessage || turn.assistantResponse || turn.aiResponse,
      })));
    }

    const validTurns = sessionTurns
      .filter((turn) => {
        const timestamp = Date.parse(String(turn.timestamp || ''));
        return Number.isFinite(timestamp) && timestamp >= now - STM_WINDOW_MS && timestamp <= now;
      })
      .filter((turn) => queryRelevant(turn, query, analysis))
      .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
      .slice(0, limit)
      .reverse();
    const turns = validTurns.map((turn) => ({
      timestamp: new Date(turn.timestamp).toISOString(),
      userMessage: String(turn.userMessage || '').trim(),
      assistantMessage: String(turn.assistantMessage || turn.assistantResponse || turn.aiResponse || '').trim(),
    }));
    const memories = turns.map((turn) => toTurnMemory(turn, safeUserId, sessionId));

    return {
      ok: true,
      memories,
      turns,
      source: 'stm',
      metadata: {
        count: turns.length,
        windowStart,
        windowEnd,
        latencyMs: Date.now() - startedAt,
      },
    };
  }
}

module.exports = {
  StmMemoryAdapter,
  STM_WINDOW_MS,
};
