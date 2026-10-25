'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const memoryServicePath = require.resolve('../memory');
const promptBuilderPath = require.resolve('./systemPromptBuilder');
const originalMemoryService = require.cache[memoryServicePath];
let memoryContext;

require.cache[memoryServicePath] = {
  id: memoryServicePath,
  filename: memoryServicePath,
  loaded: true,
  exports: {
    async prepareContext() {
      return memoryContext;
    },
  },
};
delete require.cache[promptBuilderPath];
const systemPromptBuilder = require('./systemPromptBuilder');
if (originalMemoryService) require.cache[memoryServicePath] = originalMemoryService;
else delete require.cache[memoryServicePath];

test('does not label failed or partial retrieval as included Live memory', async () => {
  memoryContext = {
    ok: false,
    systemPrompt: '',
    facts: [],
    memoryStatus: 'RETRIEVAL_FAILURE',
    errorCode: 'MEMORY_SOURCE_FAILURE',
  };
  const failed = await systemPromptBuilder.buildSystemPrompt('isolated-user', {
    trigger: 'session_start',
  });
  assert.equal(failed.memoryStatus, 'RETRIEVAL_FAILURE');
  assert.equal(failed.memoryContextIncluded, false);
  assert.equal(failed.errorCode, 'MEMORY_SOURCE_FAILURE');

  memoryContext = {
    ok: true,
    systemPrompt: 'A verified memory context.',
    facts: [{ id: 'fact-1' }],
    memoryStatus: 'PARTIAL',
    memoryContextIncluded: false,
    errorCode: 'PARTIAL_MEMORY_SOURCE_FAILURE',
  };
  const partial = await systemPromptBuilder.buildSystemPrompt('isolated-user', {
    trigger: 'session_start',
  });
  assert.equal(partial.memoryStatus, 'PARTIAL');
  assert.equal(partial.memoryContextIncluded, false);
  assert.equal(partial.errorCode, 'PARTIAL_MEMORY_SOURCE_FAILURE');
  assert.match(partial.systemPrompt, /A verified memory context/);

  memoryContext = {
    ok: true,
    systemPrompt: 'An included verified memory context.',
    facts: [{ id: 'fact-2' }],
    memoryStatus: 'MEMORY_FOUND',
    memoryContextIncluded: true,
  };
  const successful = await systemPromptBuilder.buildSystemPrompt('isolated-user', {
    trigger: 'session_start',
  });
  assert.equal(successful.memoryContextIncluded, true);
  assert.match(successful.systemPrompt, /An included verified memory context/);
});

test('adds validated local time without prompting an unsolicited welcome-back greeting', async () => {
  memoryContext = {
    ok: true,
    systemPrompt: 'Conversation context.',
    facts: [],
    memoryStatus: 'NO_MEMORY',
  };

  const result = await systemPromptBuilder.buildSystemPrompt('isolated-user', {
    trigger: 'session_start',
    activeContext: {
      localTimeZone: 'Asia/Kolkata',
      lastSessionEndedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    },
  });

  assert.match(result.systemPrompt, /User's current local date and time:/);
  assert.match(result.systemPrompt, /Asia\/Kolkata/);
  assert.match(result.systemPrompt, /only acknowledge time apart if the user brings it up/);
  assert.doesNotMatch(result.systemPrompt, /previous Kiara conversation ended/);
});

test('ignores an invalid local timezone instead of failing Live prompt setup', async () => {
  memoryContext = {
    ok: true,
    systemPrompt: 'Conversation context.',
    facts: [],
    memoryStatus: 'NO_MEMORY',
  };

  const result = await systemPromptBuilder.buildSystemPrompt('isolated-user', {
    trigger: 'session_start',
    activeContext: { localTimeZone: 'not/a-timezone' },
  });

  assert.doesNotMatch(result.systemPrompt, /User's current local date and time:/);
});
