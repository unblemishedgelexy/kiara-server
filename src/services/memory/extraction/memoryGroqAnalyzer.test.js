'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { analyzeConversation } = require('./memoryGroqAnalyzer');

test('requests structured JSON mode for durable memory extraction', async () => {
  let request;
  const result = await analyzeConversation({
    userId: 'synthetic-user',
    userMessage: 'I prefer green tea.',
  }, {
    async generateTextFn(value) {
      request = value;
      return JSON.stringify({
        candidates: [{ decision: 'NO_MEMORY', reason: 'test', confidence: 0, importance: 'LOW' }],
      });
    },
  });

  assert.equal(request.jsonMode, true);
  assert.equal(result.decision, 'NO_MEMORY');
  assert.equal(result.candidates[0].decision, 'NO_MEMORY');
  assert.equal(result.diagnostics.providerDecision, 'NO_MEMORY');
  assert.equal(result.diagnostics.candidateCount, 1);
  assert.equal(result.diagnostics.providerOperation, 'groq_memory_analysis');
  assert.equal(result.diagnostics.responseContentPresent, true);
  assert.equal(result.diagnostics.parsingSucceeded, true);
  assert.equal(result.diagnostics.validationSucceeded, true);
});

test('marks memory candidates as selected only when a candidate requests persistence', async () => {
  const result = await analyzeConversation({
    userId: 'synthetic-user',
    userMessage: 'I prefer green tea.',
  }, {
    async generateTextFn() {
      return JSON.stringify({
        candidates: [
          { decision: 'NO_MEMORY', reason: 'not durable' },
          { decision: 'MEMORY', memory: { content: 'A synthetic preference.' } },
        ],
      });
    },
  });

  assert.equal(result.decision, 'MEMORY');
  assert.equal(result.diagnostics.providerDecision, 'MEMORY');
  assert.equal(result.diagnostics.candidateCount, 2);
});

test('does not report a save decision when candidate output also contains an error', async () => {
  const result = await analyzeConversation({
    userId: 'synthetic-user',
    userMessage: 'A synthetic fact.',
  }, {
    async generateTextFn() {
      return JSON.stringify({
        candidates: [
          { decision: 'MEMORY' },
          { decision: 'ERROR' },
        ],
      });
    },
  });

  assert.equal(result.decision, 'ERROR');
  assert.equal(result.diagnostics.providerDecision, 'ERROR');
});

test('returns a safe provider error category without exposing provider error text', async () => {
  const result = await analyzeConversation({ userId: 'synthetic-user', userMessage: 'A durable preference.' }, {
    async generateTextFn() {
      throw Object.assign(new Error('sensitive provider response'), { status: 429 });
    },
  });

  assert.equal(result.failureCategory, 'INFRASTRUCTURE');
  assert.equal(result.failureCode, 'RATE_LIMIT');
  assert.equal(result.failureStatus, 429);
  assert.equal(result.reason.includes('sensitive provider response'), false);
  assert.equal(result.diagnostics.stage, 'provider_request');
  assert.equal(result.diagnostics.providerCategory, 'RATE_LIMIT');
  assert.equal(result.diagnostics.providerStatus, 429);
  assert.equal(result.diagnostics.responseContentPresent, false);
});

test('classifies provider timeouts separately from other network failures', async () => {
  const timeout = Object.assign(new Error('provider timed out'), {
    name: 'APIConnectionTimeoutError',
    code: 'ETIMEDOUT',
  });
  const result = await analyzeConversation({ userId: 'synthetic-user', userMessage: 'A durable preference.' }, {
    async generateTextFn() {
      throw timeout;
    },
  });

  assert.equal(result.failureCategory, 'INFRASTRUCTURE');
  assert.equal(result.failureCode, 'NETWORK_TIMEOUT');
  assert.equal(result.diagnostics.errorClass, 'APIConnectionTimeoutError');
  assert.equal(result.diagnostics.responseContentPresent, false);
});

test('reports malformed model output as an explicit extraction failure', async () => {
  const result = await analyzeConversation({ userId: 'synthetic-user', userMessage: 'A durable preference.' }, {
    async generateTextFn() {
      return 'not json';
    },
  });

  assert.equal(result.failureCategory, 'INVALID_OUTPUT');
  assert.equal(result.failureCode, 'INVALID_MODEL_OUTPUT');
  assert.equal(result.diagnostics.stage, 'response_parsing');
  assert.equal(result.diagnostics.responseContentPresent, true);
  assert.equal(result.diagnostics.parsingSucceeded, false);
  assert.equal(result.diagnostics.validationSucceeded, false);
});

test('reports invalid candidate schemas separately from JSON parsing failures', async () => {
  const result = await analyzeConversation({ userId: 'synthetic-user', userMessage: 'A durable preference.' }, {
    async generateTextFn() {
      return JSON.stringify({ candidates: [{ decision: 42 }] });
    },
  });

  assert.equal(result.failureCategory, 'INVALID_OUTPUT');
  assert.equal(result.diagnostics.stage, 'schema_validation');
  assert.equal(result.diagnostics.parsingSucceeded, true);
  assert.equal(result.diagnostics.validationSucceeded, false);
});
