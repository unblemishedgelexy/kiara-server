'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { extract } = require('./memoryExtractor');

const input = {
  userId: 'synthetic-user',
  sessionId: 'synthetic-session',
  userMessage: 'My synthetic project codename is Silver Kestrel 286.',
  assistantMessage: 'I will remember that synthetic fact.',
  timestamp: new Date().toISOString(),
};

test('keeps explicit NO_MEMORY separate from intentional IGNORE', async () => {
  const diagnostics = {
    stage: 'extraction_complete',
    providerDecision: 'NO_MEMORY',
    candidateCount: 0,
    responseContentPresent: true,
    parsingSucceeded: true,
    validationSucceeded: true,
  };
  const noMemory = await extract(input, {
    async analyzeConversationFn() {
      return { decision: 'NO_MEMORY', candidates: [], diagnostics };
    },
  });
  assert.equal(noMemory.decision, 'NO_MEMORY');
  assert.equal(noMemory.reasonCode, 'PROVIDER_NO_MEMORY');
  assert.deepEqual(noMemory.diagnostics, diagnostics);

  const ignored = await extract(input, {
    async analyzeConversationFn() {
      return {
        decision: 'MEMORY',
        candidates: [{ decision: 'IGNORE', reason: 'not durable' }],
      };
    },
  });
  assert.equal(ignored.decision, 'NO_OP');
  assert.equal(ignored.candidates.length, 0);
});

test('preserves safe diagnostics when all provider candidates decide NO_MEMORY', async () => {
  const diagnostics = {
    stage: 'extraction_complete',
    providerDecision: 'NO_MEMORY',
    candidateCount: 1,
    responseContentPresent: true,
    parsingSucceeded: true,
    validationSucceeded: true,
  };
  const result = await extract(input, {
    async analyzeConversationFn() {
      return {
        decision: 'NO_MEMORY',
        candidates: [{ decision: 'NO_MEMORY', reason: 'private provider text' }],
        diagnostics,
      };
    },
  });

  assert.equal(result.decision, 'NO_MEMORY');
  assert.equal(result.reasonCode, 'ALL_CANDIDATES_NO_MEMORY');
  assert.deepEqual(result.diagnostics, diagnostics);
  assert.equal(JSON.stringify(result).includes('private provider text'), false);
});

test('labels local input screening separately from a provider NO_MEMORY decision', async () => {
  let providerCalled = false;
  const result = await extract({ userId: 'synthetic-user', userMessage: '', assistantMessage: '' }, {
    async analyzeConversationFn() {
      providerCalled = true;
      return { decision: 'NO_MEMORY', candidates: [] };
    },
  });

  assert.equal(providerCalled, false);
  assert.equal(result.decision, 'NO_MEMORY');
  assert.equal(result.reasonCode, 'INPUT_SCREEN_NO_MEMORY');
  assert.equal(result.diagnostics.stage, 'input_screen');
  assert.equal(result.diagnostics.responseContentPresent, false);
  assert.equal(result.diagnostics.inputPresent, false);

  const greeting = await extract({ userId: 'synthetic-user', userMessage: 'hi', assistantMessage: '' }, {
    async analyzeConversationFn() {
      throw new Error('The provider must not be called for screened input.');
    },
  });
  assert.equal(greeting.reasonCode, 'INPUT_SCREEN_NO_MEMORY');
  assert.equal(greeting.diagnostics.inputPresent, true);
});

test('treats contradictory or missing candidate output as invalid output', async () => {
  for (const analysis of [
    null,
    { decision: 'MEMORY', candidates: [] },
    { decision: 'MEMORY' },
  ]) {
    const result = await extract(input, {
      async analyzeConversationFn() {
        return analysis;
      },
    });
    assert.equal(result.decision, 'ERROR');
    assert.equal(result.failureCategory, 'INVALID_OUTPUT');
  }
});
