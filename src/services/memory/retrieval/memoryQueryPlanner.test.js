'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createMemoryQueryPlanner,
  isPlannerEligibleQuery,
  PLAN_RESPONSE_SCHEMA,
  validatePlan,
} = require('./memoryQueryPlanner');
const { classifyGroqError } = require('../../groqService');
const { env } = require('../../../config/env');

test('does not enable the live planner from local flags during Node tests', () => {
  assert.equal(env.memoryGroqQueryPlannerEnabled, false);
});

test('accepts only strict plans with allow-listed source names', () => {
  assert.deepEqual(validatePlan({ intent: 'COMBINED', sources: ['STM', 'LONG_TERM'] }), {
    intent: 'COMBINED',
    sources: ['STM', 'LONG_TERM'],
  });
  assert.equal(validatePlan({ intent: 'COMBINED', sources: ['MONGO_ADMIN'] }), null);
  assert.equal(validatePlan({ intent: 'COMBINED', sources: ['LONG_TERM', 'LONG_TERM'] }), null);
  assert.equal(validatePlan({ intent: 'COMBINED', sources: ['LONG_TERM'], userId: 'attacker' }), null);
});

test('calls Groq once with bounded JSON-only query input for ambiguous questions', async () => {
  const calls = [];
  const planner = createMemoryQueryPlanner({
    timeoutMs: 100,
    generateTextFn: async (options) => {
      calls.push(options);
      return '{"intent":"DURABLE","sources":["LONG_TERM"]}';
    },
  });

  assert.equal(isPlannerEligibleQuery('What does the lantern code say?'), true);
  const result = await planner('What does the lantern code say?', { traceId: 'planner-test' });

  assert.deepEqual(result, { intent: 'DURABLE', sources: ['LONG_TERM'] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxCompletionTokens, 96);
  assert.equal(calls[0].timeoutMs, 100);
  assert.equal(calls[0].maxRetries, 0);
  assert.equal(calls[0].jsonMode, undefined);
  assert.deepEqual(calls[0].jsonSchema, PLAN_RESPONSE_SCHEMA);
  assert.equal(calls[0].reasoningEffort, 'low');
  assert.deepEqual(JSON.parse(calls[0].userMessage), { query: 'What does the lantern code say?' });
  assert.equal(isPlannerEligibleQuery('hello there'), false);
});

test('falls back on malformed output and planner timeout', async () => {
  const invalidPlanner = createMemoryQueryPlanner({
    generateTextFn: async () => '{"intent":"DURABLE","sources":["user-provided-filter"]}',
  });
  assert.equal(await invalidPlanner('What do I remember?'), null);

  const timeoutPlanner = createMemoryQueryPlanner({
    timeoutMs: 5,
    generateTextFn: () => new Promise(() => {}),
  });
  assert.equal(await timeoutPlanner('What do I remember?'), null);
});

test('falls back on provider errors and skips ineligible queries', async () => {
  let calls = 0;
  const providerFailurePlanner = createMemoryQueryPlanner({
    generateTextFn: async () => {
      calls += 1;
      throw new Error('provider unavailable');
    },
  });
  assert.equal(await providerFailurePlanner('What do I remember?'), null);
  assert.equal(calls, 1);

  const ineligiblePlanner = createMemoryQueryPlanner({
    generateTextFn: async () => {
      calls += 1;
      return '{"intent":"DURABLE","sources":["LONG_TERM"]}';
    },
  });
  assert.equal(await ineligiblePlanner('The weather is nice.'), null);
  assert.equal(calls, 1);
});

test('classifies structured SDK errors without exposing messages or headers', () => {
  const cases = [
    [{ status: 401, name: 'AuthenticationError', error: { code: 'invalid_api_key' } }, 'AUTHENTICATION'],
    [{ status: 404, name: 'NotFoundError', error: { code: 'model_not_found' } }, 'MODEL_OR_ENDPOINT'],
    [{ status: 429, name: 'RateLimitError', error: { code: 'rate_limit_exceeded' } }, 'RATE_LIMIT'],
    [{ name: 'APIConnectionTimeoutError' }, 'NETWORK_TIMEOUT'],
    [{ name: 'APIConnectionError', cause: { code: 'ECONNRESET' } }, 'NETWORK'],
  ];
  for (const [error, expectedCategory] of cases) {
    assert.equal(classifyGroqError(error).category, expectedCategory);
  }

  const headers = new Headers({ 'x-request-id': 'req_abc123', authorization: 'secret-token' });
  const diagnostic = classifyGroqError({
    status: 401,
    name: 'AuthenticationError',
    headers,
    error: { code: 'invalid_api_key', param: 'model', message: 'sensitive provider response' },
  });
  assert.deepEqual(diagnostic, {
    category: 'AUTHENTICATION',
    httpStatus: 401,
    providerCode: 'invalid_api_key',
    providerType: null,
    providerParam: 'model',
    requestId: 'req_abc123',
    errorName: 'AuthenticationError',
  });
  assert.equal(JSON.stringify(diagnostic).includes('secret-token'), false);
  assert.equal(JSON.stringify(diagnostic).includes('sensitive'), false);

  const invalidRequest = classifyGroqError({
    status: 400,
    error: { error: { code: 'invalid_request', type: 'invalid_request_error', message: 'private body' } },
  });
  assert.deepEqual(invalidRequest, {
    category: 'REQUEST_OR_MODEL',
    httpStatus: 400,
    providerCode: 'invalid_request',
    providerType: 'invalid_request_error',
    providerParam: null,
    requestId: null,
    errorName: null,
  });
});
