'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { env } = require('../../../config/env');
const { StmMemoryAdapter, STM_WINDOW_MS } = require('./stmMemoryAdapter');

test('uses a scoped, bounded Mongo fallback without selecting duplicated raw payloads', async () => {
  let filter;
  let projection;
  let maxTimeMs;
  const adapter = new StmMemoryAdapter({
    redis: {
      async getRecentMemory() {
        return [];
      },
    },
    conversationTurnModel: {
      find(query) {
        filter = query;
        return {
          select(value) {
            projection = value;
            return this;
          },
          sort() {
            return this;
          },
          maxTimeMS(value) {
            maxTimeMs = value;
            return this;
          },
          async lean() {
            return [];
          },
        };
      },
    },
  });

  const result = await adapter.getRecentContext({
    userId: 'scoped-user',
    sessionId: 'scoped-session',
    options: { limit: 5 },
  });

  assert.equal(result.ok, true);
  assert.equal(result.memories.length, 0);
  assert.equal(filter.userId, 'scoped-user');
  assert.equal(filter.sessionId, 'scoped-session');
  assert.ok(filter.timestamp.$gte instanceof Date);
  assert.ok(filter.timestamp.$lte instanceof Date);
  assert.ok(filter.timestamp.$lte.getTime() - filter.timestamp.$gte.getTime() <= STM_WINDOW_MS + 10);
  assert.equal(projection, 'userMessage assistantResponse timestamp');
  assert.equal(maxTimeMs, env.memoryMongoQueryTimeoutMs);
});
