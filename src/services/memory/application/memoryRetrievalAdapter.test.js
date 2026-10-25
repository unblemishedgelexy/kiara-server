'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { routeMemorySources } = require('../retrieval/sourceRouter');
const { createMemoryRetrievalAdapter } = require('./memoryRetrievalAdapter');

const USER_ID = 'isolated-user';
const QUERY = 'What does the brass telescope code say?';
const MEMORY = {
  id: 'mem_isolated_fact',
  userId: USER_ID,
  type: 'fact',
  subject: 'user',
  predicate: 'has',
  value: 'ORBIT-ALDER-731',
  content: 'The brass telescope inventory code is ORBIT-ALDER-731.',
  status: 'ACTIVE',
  version: 1,
  provenance: { conversationTurnId: 'isolated-turn' },
  score: 0.9,
};

test('routes an explicit current-fact question to STM and canonical memory', () => {
  const route = routeMemorySources('What is my current project?');
  assert.deepEqual(route.sources, ['STM', 'LONG_TERM']);
  assert.equal(route.route, 'STM_AND_LONG_TERM');
});

test('uses bounded sources when a non-empty query receives no initial route', async () => {
  const stmCalls = [];
  const retrieverCalls = [];
  const adapter = createMemoryRetrievalAdapter({
    plannerEnabled: false,
    stmAdapter: {
      async getRecentContext(options) {
        stmCalls.push(options);
        return { memories: [] };
      },
    },
    retrieverFactory: () => ({
      async retrieve(options) {
        retrieverCalls.push(options);
        return {
          memories: options.options.includeStructured ? [MEMORY] : [],
          semantic: { status: 'NOT_REQUESTED' },
        };
      },
    }),
  });

  assert.equal(routeMemorySources(QUERY).route, 'NONE');
  const result = await adapter.retrieveMemoryContext({
    userId: USER_ID,
    query: QUERY,
    sessionId: 'isolated-session',
    options: { traceId: 'isolated-trace' },
  });

  assert.equal(stmCalls.length, 1);
  assert.equal(stmCalls[0].userId, USER_ID);
  assert.equal(retrieverCalls.length, 1);
  assert.equal(retrieverCalls[0].userId, USER_ID);
  assert.equal(retrieverCalls[0].options.includeStructured, true);
  assert.equal(retrieverCalls[0].options.includeSemantic, false);
  assert.equal(result.ok, true);
  assert.equal(result.memories[0].id, MEMORY.id);
  assert.equal(result.memories[0].version, MEMORY.version);
  assert.deepEqual(result.memories[0].provenance, MEMORY.provenance);
  assert.match(result.context, /ORBIT-ALDER-731/);
  assert.equal(result.metadata.status, 'MEMORY_FOUND');
  assert.equal(result.metadata.routeMissFallback, true);
  assert.deepEqual(result.metadata.sourcesAttempted, ['stm', 'long_term']);
});

test('reports NO_MATCH after one bounded fallback pass', async () => {
  const retrieverCalls = [];
  const adapter = createMemoryRetrievalAdapter({
    plannerEnabled: false,
    stmAdapter: { async getRecentContext() { return { memories: [] }; } },
    retrieverFactory: () => ({
      async retrieve(options) {
        retrieverCalls.push(options.options);
        return { memories: [], semantic: { status: options.options.includeSemantic ? 'SEMANTIC_NO_MATCH' : 'NOT_REQUESTED' } };
      },
    }),
  });

  const result = await adapter.retrieveMemoryContext({
    userId: USER_ID,
    query: QUERY,
    sessionId: 'isolated-session',
    options: { traceId: 'no-match-trace' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.metadata.status, 'NO_MATCH');
  assert.equal(result.metadata.fallbackPasses, 1);
  assert.deepEqual(result.metadata.sourcesAttempted, ['stm', 'long_term', 'semantic']);
  assert.equal(retrieverCalls.length, 2);
  assert.equal(retrieverCalls[1].includeStructured, false);
  assert.equal(retrieverCalls[1].includeSemantic, true);
});

test('adds only validated planner sources to the authenticated empty-route fallback', async () => {
  const retrieverCalls = [];
  const plannerCalls = [];
  const adapter = createMemoryRetrievalAdapter({
    plannerEnabled: true,
    async planMemoryQuery(query, options) {
      plannerCalls.push({ query, options });
      return { intent: 'SEMANTIC', sources: ['SEMANTIC'] };
    },
    stmAdapter: { async getRecentContext({ userId }) { assert.equal(userId, USER_ID); return { memories: [] }; } },
    retrieverFactory: () => ({
      async retrieve(options) {
        retrieverCalls.push(options);
        return { memories: [], semantic: { status: 'SEMANTIC_NO_MATCH' } };
      },
    }),
  });

  const result = await adapter.retrieveMemoryContext({
    userId: USER_ID,
    query: QUERY,
    sessionId: 'isolated-session',
    options: { traceId: 'planner-integration-trace' },
  });

  assert.equal(result.metadata.status, 'NO_MATCH');
  assert.equal(result.metadata.plannerStatus, 'VALID');
  assert.deepEqual(result.metadata.plannedSources, ['SEMANTIC']);
  assert.equal(plannerCalls.length, 1);
  assert.equal(plannerCalls[0].query, QUERY);
  assert.equal(plannerCalls[0].options.traceId, 'planner-integration-trace');
  assert.equal(retrieverCalls.length, 2);
  assert.equal(retrieverCalls[0].userId, USER_ID);
  assert.equal(retrieverCalls[0].options.includeStructured, true);
  assert.equal(retrieverCalls[1].options.includeSemantic, true);
  assert.deepEqual(result.metadata.sourcesAttempted, ['stm', 'long_term', 'semantic']);
  assert.equal(result.metadata.plannerStatus, 'VALID');
});

test('does not call the query planner when the feature flag is disabled', async () => {
  let plannerCalls = 0;
  const adapter = createMemoryRetrievalAdapter({
    plannerEnabled: false,
    async planMemoryQuery() {
      plannerCalls += 1;
      return { intent: 'SEMANTIC', sources: ['SEMANTIC'] };
    },
    stmAdapter: { async getRecentContext() { return { memories: [] }; } },
    retrieverFactory: () => ({
      async retrieve() {
        return { memories: [], semantic: { status: 'NOT_REQUESTED' } };
      },
    }),
  });

  const result = await adapter.retrieveMemoryContext({
    userId: USER_ID,
    query: QUERY,
    sessionId: 'isolated-session',
    options: { traceId: 'planner-disabled-trace' },
  });

  assert.equal(result.metadata.status, 'NO_MATCH');
  assert.equal(plannerCalls, 0);
  assert.equal(result.metadata.plannerStatus, 'DISABLED');
  assert.deepEqual(result.metadata.sourcesAttempted, ['stm', 'long_term', 'semantic']);
});

test('keeps deterministic sources when the enabled planner fails', async () => {
  const retrieverCalls = [];
  const adapter = createMemoryRetrievalAdapter({
    plannerEnabled: true,
    async planMemoryQuery() {
      return null;
    },
    stmAdapter: { async getRecentContext() { return { memories: [] }; } },
    retrieverFactory: () => ({
      async retrieve(options) {
        retrieverCalls.push(options);
        return { memories: [], semantic: { status: 'NOT_REQUESTED' } };
      },
    }),
  });

  const result = await adapter.retrieveMemoryContext({
    userId: USER_ID,
    query: QUERY,
    sessionId: 'isolated-session',
    options: { traceId: 'planner-provider-failure-trace' },
  });

  assert.equal(result.metadata.status, 'NO_MATCH');
  assert.equal(result.metadata.plannerStatus, 'FALLBACK');
  assert.equal(retrieverCalls.length, 2);
  assert.equal(retrieverCalls[0].options.includeStructured, true);
  assert.equal(retrieverCalls[0].options.includeSemantic, false);
  assert.deepEqual(result.metadata.sourcesAttempted, ['stm', 'long_term', 'semantic']);
  assert.equal(result.metadata.fallbackPasses, 1);
});

test('reports SOURCE_ERROR when all attempted retrieval passes fail', async () => {
  const adapter = createMemoryRetrievalAdapter({
    plannerEnabled: false,
    stmAdapter: { async getRecentContext() { throw Object.assign(new Error('unavailable'), { code: 'STM_DOWN' }); } },
    retrieverFactory: () => ({
      async retrieve() { throw Object.assign(new Error('unavailable'), { code: 'CANONICAL_DOWN' }); },
    }),
  });

  const result = await adapter.retrieveMemoryContext({
    userId: USER_ID,
    query: QUERY,
    sessionId: 'isolated-session',
    options: { traceId: 'source-error-trace' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.metadata.status, 'SOURCE_ERROR');
  assert.equal(result.metadata.fallbackPasses, 1);
  assert.equal(result.metadata.sourceFailures.stm, 'STM_DOWN');
  assert.equal(result.metadata.sourceFailures.long_term, 'CANONICAL_DOWN');
});

test('bounds a stalled canonical source and reports its timeout', async () => {
  const retrieverCalls = [];
  const adapter = createMemoryRetrievalAdapter({
    plannerEnabled: false,
    sourceTimeoutMs: 10000,
    stmAdapter: { async getRecentContext() { return { memories: [] }; } },
    retrieverFactory: () => ({
      async retrieve(options) {
        retrieverCalls.push(options.options);
        if (options.options.includeStructured) {
          return new Promise((resolve, reject) => {
            setTimeout(() => reject(Object.assign(new Error('late source failure'), { code: 'LATE_CANONICAL_FAILURE' })), 20);
          });
        }
        return { memories: [], semantic: { status: 'SEMANTIC_NO_MATCH' } };
      },
    }),
  });

  const result = await adapter.retrieveMemoryContext({
    userId: USER_ID,
    query: QUERY,
    sessionId: 'isolated-session',
    options: { traceId: 'canonical-timeout-trace', sourceTimeoutMs: 5 },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(result.ok, false);
  assert.equal(result.metadata.status, 'SOURCE_ERROR');
  assert.equal(result.metadata.sourceFailures.long_term, 'CANONICAL_RETRIEVAL_TIMEOUT');
  assert.equal(result.metadata.fallbackPasses, 1);
  assert.equal(retrieverCalls.length, 2);
  assert.deepEqual(result.metadata.sourcesAttempted, ['stm', 'long_term', 'semantic']);
});

test('keeps the complete fallback within the Live overall retrieval deadline', async () => {
  const canonicalCalls = [];
  let stmCalls = 0;
  const adapter = createMemoryRetrievalAdapter({
    plannerEnabled: false,
    sourceTimeoutMs: 10000,
    stmAdapter: {
      async getRecentContext() {
        stmCalls += 1;
        return { memories: [] };
      },
    },
    retrieverFactory: () => ({
      async retrieve({ options }) {
        canonicalCalls.push(options);
        if (options.includeStructured) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { memories: [], semantic: { status: 'NOT_REQUESTED' } };
        }
        return new Promise(() => {});
      },
    }),
  });
  const startedAt = Date.now();

  const result = await adapter.retrieveMemoryContext({
    userId: USER_ID,
    query: 'What is my current project?',
    sessionId: 'isolated-session',
    options: {
      traceId: 'live-timeout-budget-trace',
      sourceTimeoutMs: 1000,
      retrievalTimeoutMs: 500,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.metadata.fallbackPasses, 1);
  assert.equal(canonicalCalls.length, 2);
  assert.equal(canonicalCalls[1].includeSemantic, true);
  assert.equal(stmCalls, 1);
  assert.ok(Date.now() - startedAt < 900, 'the fallback must use only the remaining retrieval budget');
  assert.equal(result.metadata.sourceFailures.semantic, 'MEMORY_RETRIEVAL_DEADLINE');
});

test('deduplicates identical in-flight requests across trace IDs', async () => {
  let stmCalls = 0;
  let release;
  const waitForSource = new Promise((resolve) => { release = resolve; });
  const adapter = createMemoryRetrievalAdapter({
    plannerEnabled: false,
    stmAdapter: {
      async getRecentContext() {
        stmCalls += 1;
        await waitForSource;
        return { memories: [] };
      },
    },
    retrieverFactory: () => ({
      async retrieve() {
        return { memories: [], semantic: { status: 'NOT_REQUESTED' } };
      },
    }),
  });
  const request = {
    userId: USER_ID,
    query: 'What is my current project?',
    sessionId: 'same-session',
    options: { traceId: 'first-trace' },
  };
  const first = adapter.retrieveMemoryContext(request);
  const second = adapter.retrieveMemoryContext({
    ...request,
    options: { traceId: 'second-trace' },
  });
  release();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(stmCalls, 1);
  assert.equal(firstResult, secondResult);
});

test('marks a result partial when one source fails but another returns memory', async () => {
  const adapter = createMemoryRetrievalAdapter({
    plannerEnabled: false,
    stmAdapter: {
      async getRecentContext() {
        throw Object.assign(new Error('Redis unavailable'), { code: 'REDIS_UNAVAILABLE' });
      },
    },
    retrieverFactory: () => ({
      async retrieve() {
        return { memories: [MEMORY], semantic: { status: 'NOT_REQUESTED' } };
      },
    }),
  });

  const result = await adapter.retrieveMemoryContext({
    userId: USER_ID,
    query: 'What is my current project?',
    sessionId: 'partial-session',
    options: { traceId: 'partial-result-trace' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.metadata.status, 'PARTIAL');
  assert.equal(result.metadata.sourceFailures.stm, 'REDIS_UNAVAILABLE');
  assert.equal(result.memories[0].id, MEMORY.id);
});
