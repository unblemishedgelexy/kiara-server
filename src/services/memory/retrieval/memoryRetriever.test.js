'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MemoryRetriever } = require('./memoryRetriever');

const USER_ID = 'isolated-user';
const OTHER_USER_ID = 'another-user';
const CURRENT_MEMORY = {
  id: 'mem_current_project',
  userId: USER_ID,
  type: 'project',
  subject: 'user',
  predicate: 'works on',
  value: 'Kiara AI',
  content: 'The current project is Kiara AI.',
  status: 'ACTIVE',
  version: 3,
  provenance: { conversationTurnId: 'turn-3' },
};

function createRetriever({ cached = [], repositoryMemories = [] } = {}) {
  const repositoryCalls = [];
  const getByIdCalls = [];
  const repository = {
    async findActiveByUser(userId, options) {
      repositoryCalls.push({ userId, options });
      return repositoryMemories;
    },
    async getById(userId, memoryId) {
      getByIdCalls.push({ userId, memoryId });
      const found = repositoryMemories.find((memory) => memory.userId === userId && memory.id === memoryId);
      if (!found) throw Object.assign(new Error('not found'), { name: 'MemoryNotFoundError' });
      return found;
    },
  };
  const retriever = new MemoryRetriever({
    repository,
    cache: { async getByUser() { return cached; } },
    semantic: { async query() { return { status: 'SEMANTIC_NO_MATCH', matches: [] }; } },
    embedQueryFn: async () => [],
  });
  return { retriever, repositoryCalls, getByIdCalls };
}

test('returns only ACTIVE canonical memories validated for the requested user', async () => {
  const otherUsersMemory = {
    ...CURRENT_MEMORY,
    id: 'mem_other_users_project',
    userId: OTHER_USER_ID,
  };
  const { retriever, repositoryCalls, getByIdCalls } = createRetriever({
    repositoryMemories: [CURRENT_MEMORY, otherUsersMemory],
  });

  const result = await retriever.retrieve({
    userId: USER_ID,
    query: 'What is my current project?',
    options: { includeSemantic: false },
  });

  assert.equal(repositoryCalls.length, 1);
  assert.equal(repositoryCalls[0].userId, USER_ID);
  assert.deepEqual(result.memories.map((memory) => memory.id), [CURRENT_MEMORY.id]);
  assert.equal(result.memories[0].status, 'ACTIVE');
  assert.equal(result.memories[0].version, CURRENT_MEMORY.version);
  assert.deepEqual(result.memories[0].provenance, CURRENT_MEMORY.provenance);
  assert.ok(getByIdCalls.every((call) => call.userId === USER_ID));
});

test('falls back to Mongo when matching cache hints fail authoritative validation', async () => {
  const staleCacheHint = {
    ...CURRENT_MEMORY,
    id: 'mem_stale_cache_hint',
  };
  const { retriever, repositoryCalls, getByIdCalls } = createRetriever({
    cached: [staleCacheHint],
    repositoryMemories: [CURRENT_MEMORY],
  });

  const result = await retriever.retrieve({
    userId: USER_ID,
    query: 'What is my current project?',
    options: { includeSemantic: false },
  });

  assert.deepEqual(result.memories.map((memory) => memory.id), [CURRENT_MEMORY.id]);
  assert.equal(repositoryCalls.length, 1);
  assert.equal(repositoryCalls[0].userId, USER_ID);
  assert.ok(getByIdCalls.every((call) => call.userId === USER_ID));
  assert.equal(result.memories[0].version, CURRENT_MEMORY.version);
});

test('validates candidate IDs with a user-scoped repository batch when available', async () => {
  const batchCalls = [];
  const repository = {
    async findActiveByUser(userId) {
      assert.equal(userId, USER_ID);
      return [CURRENT_MEMORY];
    },
    async getManyByIds(userId, memoryIds) {
      batchCalls.push({ userId, memoryIds });
      return [CURRENT_MEMORY];
    },
    async getById() {
      assert.fail('batched authoritative reads should avoid per-memory queries');
    },
  };
  const retriever = new MemoryRetriever({
    repository,
    cache: { async getByUser() { return []; } },
    semantic: { async query() { return { status: 'SEMANTIC_NO_MATCH', matches: [] }; } },
    embedQueryFn: async () => [],
  });

  const result = await retriever.retrieve({
    userId: USER_ID,
    query: 'What is my current project?',
    options: { includeSemantic: false },
  });

  assert.deepEqual(result.memories.map((memory) => memory.id), [CURRENT_MEMORY.id]);
  assert.equal(batchCalls.length, 1);
  assert.ok(batchCalls.every((call) => call.userId === USER_ID));
  assert.ok(batchCalls.every((call) => call.memoryIds.includes(CURRENT_MEMORY.id)));
});

test('reports cache, repository, and authoritative validation timings without raw query or user ID', async () => {
  const { retriever } = createRetriever({ repositoryMemories: [CURRENT_MEMORY] });
  const originalInfo = console.info;
  const events = [];
  console.info = (label, payload) => {
    if (label === '[MEMORY_RETRIEVAL_DETAIL]') events.push(JSON.parse(payload));
  };

  try {
    await retriever.retrieve({
      userId: USER_ID,
      query: 'What is my current project?',
      options: { includeSemantic: false, traceId: 'stage-timing-trace' },
    });
  } finally {
    console.info = originalInfo;
  }

  assert.deepEqual(events.map((event) => event.stage), [
    'redis_cache_lookup',
    'mongo_repository_read',
    'mongo_authoritative_validation',
  ]);
  assert.ok(events.every((event) => event.traceId === 'stage-timing-trace'));
  assert.ok(events.every((event) => event.userIdHash && !JSON.stringify(event).includes(USER_ID)));
  assert.ok(events.every((event) => !JSON.stringify(event).includes('What is my current project?')));
  assert.ok(events.every((event) => Number.isFinite(event.elapsedMs)));
});
