'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MemoryConsolidator } = require('./memoryConsolidator');
const { detectDuplicate } = require('./duplicateDetector');

const duplicateContent = 'Please remember this synthetic durable fact: my project codename for this test is Silver Kestrel 286. It is fictional and only for validating memory.';

test('detects identical canonical content even when extraction assigns different types', () => {
  assert.equal(detectDuplicate(
    { id: 'existing-project', type: 'project', content: duplicateContent, status: 'ACTIVE' },
    { id: 'new-fact', type: 'fact', content: duplicateContent, status: 'ACTIVE' },
  ), true);
});

test('does not create a second canonical record for an exact cross-type duplicate', async () => {
  let createCalls = 0;
  const repository = {
    async findActiveByUser() {
      return [{
        id: 'existing-project',
        userId: 'synthetic-user',
        type: 'project',
        content: duplicateContent,
        status: 'ACTIVE',
      }];
    },
    async create() {
      createCalls += 1;
      throw new Error('duplicate candidate should not be created');
    },
  };
  const consolidator = new MemoryConsolidator({ repository, cache: null });
  const result = await consolidator.consolidate({
    userId: 'synthetic-user',
    candidate: {
      id: 'new-fact',
      userId: 'synthetic-user',
      type: 'fact',
      subject: 'user',
      predicate: 'has',
      value: duplicateContent,
      content: duplicateContent,
      source: { type: 'CONVERSATION' },
      status: 'ACTIVE',
    },
  });

  assert.equal(result.decision, 'DUPLICATE');
  assert.equal(result.reasonCode, 'EXISTING_MEMORY_MATCH');
  assert.equal(result.persistenceAttempted, false);
  assert.equal(result.persisted, false);
  assert.equal(createCalls, 0);
});
