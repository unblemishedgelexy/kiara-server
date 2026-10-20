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

async function captureRetrievalLog(callback) {
  const originalInfo = console.info;
  let event = null;
  console.info = (label, payload) => {
    if (label === '[MEMORY_RETRIEVAL_STAGE]') event = JSON.parse(payload);
  };
  try {
    return { result: await callback(), event };
  } finally {
    console.info = originalInfo;
  }
}

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
  const { result, event } = await captureRetrievalLog(() => adapter.retrieveMemoryContext({
    userId: USER_ID,
    query: QUERY,
    sessionId: 'isolated-session',
    options: { traceId: 'isolated-trace' },
  }));

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
  assert.equal(event.status, 'MEMORY_FOUND');
  assert.equal(event.routeMissFallback, true);
  assert.deepEqual(event.sourcesAttempted, ['STM', 'LONG_TERM']);
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

  const { result, event } = await captureRetrievalLog(() => adapter.retrieveMemoryContext({
    userId: USER_ID,
    query: QUERY,
    sessionId: 'isolated-session',
    options: { traceId: 'no-match-trace' },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.metadata.status, 'NO_MATCH');
  assert.equal(event.status, 'NO_MATCH');
  assert.equal(event.fallbackPasses, 1);
  assert.deepEqual(event.sourcesAttempted, ['STM', 'LONG_TERM', 'SEMANTIC']);
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

  const { result, event } = await captureRetrievalLog(() => adapter.retrieveMemoryContext({
    userId: USER_ID,
    query: QUERY,
    sessionId: 'isolated-session',
    options: { traceId: 'planner-integration-trace' },
  }));

  assert.equal(result.metadata.status, 'NO_MATCH');
  assert.equal(result.metadata.plannerStatus, 'VALID');
  assert.deepEqual(result.metadata.plannedSources, ['SEMANTIC']);
  assert.equal(plannerCalls.length, 1);
  assert.equal(plannerCalls[0].query, QUERY);
  assert.equal(plannerCalls[0].options.traceId, 'planner-integration-trace');
  assert.equal(retrieverCalls.length, 1);
  assert.equal(retrieverCalls[0].userId, USER_ID);
  assert.deepEqual(event.sourcesAttempted, ['STM', 'LONG_TERM', 'SEMANTIC']);
  assert.equal(event.plannerStatus, 'VALID');
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

  const { result, event } = await captureRetrievalLog(() => adapter.retrieveMemoryContext({
    userId: USER_ID,
    query: QUERY,
    sessionId: 'isolated-session',
    options: { traceId: 'planner-disabled-trace' },
  }));

  assert.equal(result.metadata.status, 'NO_MATCH');
  assert.equal(plannerCalls, 0);
  assert.equal(event.plannerStatus, 'DISABLED');
  assert.deepEqual(event.sourcesAttempted, ['STM', 'LONG_TERM', 'SEMANTIC']);
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

  const { result, event } = await captureRetrievalLog(() => adapter.retrieveMemoryContext({
    userId: USER_ID,
    query: QUERY,
    sessionId: 'isolated-session',
    options: { traceId: 'planner-provider-failure-trace' },
  }));

  assert.equal(result.metadata.status, 'NO_MATCH');
  assert.equal(event.plannerStatus, 'FALLBACK');
  assert.equal(retrieverCalls.length, 2);
  assert.equal(retrieverCalls[0].options.includeStructured, true);
  assert.equal(retrieverCalls[0].options.includeSemantic, false);
  assert.deepEqual(event.sourcesAttempted, ['STM', 'LONG_TERM', 'SEMANTIC']);
  assert.equal(event.fallbackPasses, 1);
});

test('reports SOURCE_ERROR when all attempted retrieval passes fail', async () => {
  const adapter = createMemoryRetrievalAdapter({
    plannerEnabled: false,
    stmAdapter: { async getRecentContext() { throw Object.assign(new Error('unavailable'), { code: 'STM_DOWN' }); } },
    retrieverFactory: () => ({
      async retrieve() { throw Object.assign(new Error('unavailable'), { code: 'CANONICAL_DOWN' }); },
    }),
  });

  const { result, event } = await captureRetrievalLog(() => adapter.retrieveMemoryContext({
    userId: USER_ID,
    query: QUERY,
    sessionId: 'isolated-session',
    options: { traceId: 'source-error-trace' },
  }));

  assert.equal(result.ok, false);
  assert.equal(result.metadata.status, 'SOURCE_ERROR');
  assert.equal(event.status, 'SOURCE_ERROR');
  assert.equal(event.fallbackPasses, 1);
  assert.equal(event.sourceFailures.stm, 'STM_DOWN');
  assert.equal(event.sourceFailures.canonical, 'CANONICAL_DOWN');
});

test('bounds a stalled canonical source and reports its timeout', async () => {
  const retrieverCalls = [];
  const lateSettlements = [];
  const originalWarn = console.warn;
  console.warn = (label, payload) => {
    if (label === '[MEMORY_SOURCE_LATE_SETTLEMENT]') lateSettlements.push(JSON.parse(payload));
  };
  const adapter = createMemoryRetrievalAdapter({
    plannerEnabled: false,
    sourceTimeoutMs: 5,
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

  try {
    const { result, event } = await captureRetrievalLog(() => adapter.retrieveMemoryContext({
      userId: USER_ID,
      query: QUERY,
      sessionId: 'isolated-session',
      options: { traceId: 'canonical-timeout-trace' },
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(result.ok, false);
    assert.equal(result.metadata.status, 'SOURCE_ERROR');
    assert.equal(event.sourceFailures.canonical, 'CANONICAL_RETRIEVAL_TIMEOUT');
    assert.equal(event.fallbackPasses, 1);
    assert.equal(retrieverCalls.length, 2);
    assert.deepEqual(event.sourcesAttempted, ['STM', 'LONG_TERM', 'SEMANTIC']);
    assert.equal(lateSettlements.length, 1);
    assert.equal(lateSettlements[0].status, 'failed');
    assert.equal(lateSettlements[0].errorCode, 'LATE_CANONICAL_FAILURE');
  } finally {
    console.warn = originalWarn;
  }
});
