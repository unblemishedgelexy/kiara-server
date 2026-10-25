'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createMemoryWriteAdapter } = require('./memoryWriteAdapter');

test('preserves safe extraction diagnostics for canonical write failures', async () => {
  const adapter = createMemoryWriteAdapter({
    async extractMemory() {
      return {
        ok: false,
        decision: 'ERROR',
        failureCategory: 'INFRASTRUCTURE',
        failureCode: 'RATE_LIMIT',
        failureStatus: 429,
      };
    },
  });

  const result = await adapter.saveConversationMemory({
    userId: 'synthetic-user',
    sessionId: 'synthetic-session',
    userMessage: 'I prefer green tea.',
    assistantMessage: 'I will remember that preference.',
    timestamp: new Date().toISOString(),
  });

  assert.equal(result.status, 'EXTRACTION_FAILURE');
  assert.equal(result.metadata.extractionFailureCode, 'RATE_LIMIT');
  assert.equal(result.metadata.extractionFailureCategory, 'INFRASTRUCTURE');
  assert.equal(result.metadata.extractionFailureStatus, 429);
});

test('sanitizes unexpected extraction diagnostic codes', async () => {
  const adapter = createMemoryWriteAdapter({
    async extractMemory() {
      return {
        ok: false,
        decision: 'ERROR',
        failureCategory: 'INFRASTRUCTURE',
        failureCode: 'provider error: sensitive details',
      };
    },
  });

  const result = await adapter.saveConversationMemory({
    userId: 'synthetic-user',
    sessionId: 'synthetic-session',
    userMessage: 'I prefer green tea.',
    assistantMessage: 'I will remember that preference.',
    timestamp: new Date().toISOString(),
  });

  assert.equal(result.metadata.extractionFailureCode, 'MEMORY_EXTRACTION_FAILURE');
});

test('reports candidate validation rejection separately from no-memory', async () => {
  const adapter = createMemoryWriteAdapter({
    async extractMemory() {
      return {
        ok: false,
        decision: 'CANDIDATES_REJECTED',
        candidates: [],
        reason: 'All extracted candidates failed canonical validation.',
      };
    },
  });

  const result = await adapter.saveConversationMemory({
    userId: 'synthetic-user',
    sessionId: 'synthetic-session',
    userMessage: 'A durable preference candidate.',
    assistantMessage: 'Understood.',
    timestamp: new Date().toISOString(),
  });

  assert.equal(result.status, 'VALIDATION_REJECTION');
  assert.equal(result.metadata.extractionDecision, 'CANDIDATES_REJECTED');
  assert.equal(result.metadata.extractionFailureCategory, undefined);
  assert.equal(result.metadata.persistenceAttempted, false);
});

test('keeps explicit extractor no-memory distinct from a selected candidate rejected by policy', async () => {
  const noMemoryAdapter = createMemoryWriteAdapter({
    async extractMemory() {
      return {
        ok: false,
        decision: 'NO_MEMORY',
        candidates: [],
        reasonCode: 'PROVIDER_NO_MEMORY',
        diagnostics: {
          stage: 'extraction_complete',
          providerDecision: 'NO_MEMORY',
          responseContentPresent: true,
          parsingSucceeded: true,
          validationSucceeded: true,
        },
      };
    },
  });
  const noMemory = await noMemoryAdapter.saveConversationMemory({
    userId: 'synthetic-user',
    sessionId: 'synthetic-session',
    userMessage: 'Hello there, how are you?',
    assistantMessage: 'I am doing well.',
    timestamp: new Date().toISOString(),
  });
  assert.equal(noMemory.status, 'NO_MEMORY');
  assert.equal(noMemory.metadata.writeStage, 'extraction_decision');
  assert.equal(noMemory.metadata.mongoAcknowledged, null);
  assert.equal(noMemory.metadata.extractionReasonCode, 'PROVIDER_NO_MEMORY');
  assert.equal(noMemory.metadata.extractionDiagnostics.providerDecision, 'NO_MEMORY');

  const rejectedAdapter = createMemoryWriteAdapter({
    async extractMemory() {
      return {
        ok: true,
        decision: 'MEMORY',
        candidates: [{ decision: 'MEMORY', memory: { content: 'A selected candidate.' } }],
      };
    },
    consolidator: {
      async consolidate() {
        return {
          decision: 'IGNORE',
          reasonCode: 'TRIVIAL_CANDIDATE',
          persisted: false,
          reason: 'Candidate is too trivial to persist.',
        };
      },
    },
    semantic: null,
  });
  const rejected = await rejectedAdapter.saveConversationMemory({
    userId: 'synthetic-user',
    sessionId: 'synthetic-session',
    userMessage: 'A durable synthetic fact worth remembering.',
    assistantMessage: 'Understood.',
    timestamp: new Date().toISOString(),
  });
  assert.equal(rejected.status, 'VALIDATION_REJECTION');
  assert.equal(rejected.metadata.extractionDecision, 'MEMORY');
  assert.equal(rejected.metadata.writeStage, 'candidate_validation');
  assert.equal(rejected.metadata.validationFailureCode, 'TRIVIAL_CANDIDATE');
  assert.equal(rejected.metadata.persistenceConfirmed, false);
  assert.equal(rejected.metadata.mongoAcknowledged, null);
});

test('reports a genuine extractor no-op distinctly from a no-memory decision', async () => {
  const adapter = createMemoryWriteAdapter({
    async extractMemory() {
      return { ok: false, decision: 'NO_OP', candidates: [] };
    },
  });
  const result = await adapter.saveConversationMemory({
    userId: 'synthetic-user',
    sessionId: 'synthetic-session',
    userMessage: 'A synthetic statement the extractor intentionally ignores.',
    assistantMessage: 'Understood.',
    timestamp: new Date().toISOString(),
  });
  assert.equal(result.status, 'NO_OP');
  assert.equal(result.metadata.extractionDecision, 'NO_OP');
  assert.equal(result.metadata.writeStage, 'extraction_no_op');
  assert.equal(result.metadata.persistenceAttempted, false);
  assert.equal(result.metadata.mongoAcknowledged, null);
});

test('classifies small-talk eligibility skips as no-op, not extractor no-memory', async () => {
  let extractionCalled = false;
  const adapter = createMemoryWriteAdapter({
    async extractMemory() {
      extractionCalled = true;
      return { ok: false, decision: 'NO_MEMORY', candidates: [] };
    },
  });
  const result = await adapter.saveConversationMemory({
    userId: 'synthetic-user',
    sessionId: 'synthetic-session',
    userMessage: 'okay',
    assistantMessage: 'Hi!',
    timestamp: new Date().toISOString(),
  });
  assert.equal(result.status, 'NO_OP');
  assert.equal(result.metadata.extractionDecision, 'SKIPPED_SMALL_TALK');
  assert.equal(result.metadata.writeStage, 'memory_eligibility');
  assert.equal(extractionCalled, false);
});

test('reports duplicate candidates as intentional no-op without claiming persistence', async () => {
  const adapter = createMemoryWriteAdapter({
    async extractMemory() {
      return {
        ok: true,
        decision: 'MEMORY',
        candidates: [{ decision: 'MEMORY', memory: { content: 'The test fact.' } }],
      };
    },
    consolidator: {
      async consolidate() {
        return { decision: 'DUPLICATE', persisted: false };
      },
    },
    semantic: null,
  });
  const result = await adapter.saveConversationMemory({
    userId: 'synthetic-user',
    sessionId: 'synthetic-session',
    userMessage: 'Remember the synthetic test fact.',
    assistantMessage: 'Understood.',
    timestamp: new Date().toISOString(),
  });
  assert.equal(result.status, 'DUPLICATE');
  assert.equal(result.metadata.persistenceAttempted, false);
  assert.equal(result.metadata.persistenceConfirmed, false);
  assert.equal(result.metadata.mongoStatus, 'NOT_ATTEMPTED');
  assert.equal(result.metadata.mongoAcknowledged, null);
});

test('labels shadow extraction as a dry run, never as persisted success', async () => {
  const adapter = createMemoryWriteAdapter({
    async extractMemory() {
      return {
        ok: true,
        decision: 'MEMORY',
        candidates: [{ decision: 'MEMORY', memory: { content: 'The test fact.' } }],
      };
    },
    consolidator: {
      async consolidate() {
        return { decision: 'CREATE', persisted: false };
      },
    },
    semantic: null,
  });
  const result = await adapter.saveConversationMemory({
    userId: 'synthetic-user',
    sessionId: 'synthetic-session',
    userMessage: 'Remember the synthetic test fact.',
    assistantMessage: 'Understood.',
    timestamp: new Date().toISOString(),
    options: { dryRun: true },
  });
  assert.equal(result.status, 'DRY_RUN');
  assert.equal(result.saved, false);
  assert.equal(result.metadata.persistenceConfirmed, false);
  assert.equal(result.metadata.mongoAcknowledged, null);
});

test('confirms persistence only when the canonical write returns a saved record', async () => {
  const adapter = createMemoryWriteAdapter({
    async extractMemory() {
      return {
        ok: true,
        decision: 'MEMORY',
        candidates: [{
          decision: 'MEMORY',
          memory: {
            type: 'fact',
            subject: 'synthetic user',
            predicate: 'has project codename',
            value: 'Saffron Comet 742',
            content: 'Synthetic project codename is Saffron Comet 742.',
          },
        }],
      };
    },
    consolidator: {
      async consolidate({ candidate }) {
        return {
          decision: 'CREATE',
          persistenceAttempted: true,
          persisted: true,
          result: candidate,
        };
      },
    },
    semantic: {
      async upsert() {
        return {};
      },
    },
  });
  const result = await adapter.saveConversationMemory({
    userId: 'synthetic-user',
    sessionId: 'synthetic-session',
    userMessage: 'My project codename is Saffron Comet 742.',
    assistantMessage: 'I will remember that synthetic fact.',
    timestamp: new Date().toISOString(),
  });
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.saved, true);
  assert.equal(result.metadata.persistenceAttempted, true);
  assert.equal(result.metadata.persistenceConfirmed, true);
  assert.equal(result.metadata.mongoAcknowledged, true);
  assert.equal(result.metadata.writeStage, 'persistence_confirmation');
});

test('reports an attempted but unacknowledged Mongo write as persistence failure', async () => {
  const adapter = createMemoryWriteAdapter({
    async extractMemory() {
      return {
        ok: true,
        decision: 'MEMORY',
        candidates: [{
          decision: 'MEMORY',
          memory: {
            type: 'fact',
            subject: 'synthetic user',
            predicate: 'has project codename',
            value: 'Saffron Comet 742',
            content: 'Synthetic project codename is Saffron Comet 742.',
          },
        }],
      };
    },
    consolidator: {
      async consolidate() {
        return {
          decision: 'CREATE',
          persisted: false,
          persistenceAttempted: true,
          error: Object.assign(new Error('write failed'), { code: 'MONGO_FAILURE' }),
        };
      },
    },
    semantic: null,
  });
  const result = await adapter.saveConversationMemory({
    userId: 'synthetic-user',
    sessionId: 'synthetic-session',
    userMessage: 'My project codename is Saffron Comet 742.',
    assistantMessage: 'I will remember that synthetic fact.',
    timestamp: new Date().toISOString(),
  });
  assert.equal(result.status, 'MONGO_FAILURE');
  assert.equal(result.metadata.writeStage, 'canonical_persistence');
  assert.equal(result.metadata.persistenceAttempted, true);
  assert.equal(result.metadata.persistenceConfirmed, false);
  assert.equal(result.metadata.mongoStatus, 'FAILED');
  assert.equal(result.metadata.mongoAcknowledged, false);
});

test('keeps repository errors distinct from extraction failures', async () => {
  const adapter = createMemoryWriteAdapter({
    async extractMemory() {
      return {
        ok: true,
        decision: 'MEMORY',
        candidates: [{
          decision: 'MEMORY',
          memory: {
            type: 'preference',
            content: 'The synthetic user prefers jasmine tea.',
            confidence: { value: 0.9, label: 'HIGH' },
            importance: 'MEDIUM',
          },
        }],
      };
    },
    consolidator: {
      async consolidate() {
        throw Object.assign(new Error('database unavailable'), { code: 'MONGO_FAILURE' });
      },
    },
    semantic: null,
  });

  const result = await adapter.saveConversationMemory({
    userId: 'synthetic-user',
    sessionId: 'synthetic-session',
    userMessage: 'I prefer jasmine tea.',
    assistantMessage: 'Understood.',
    timestamp: new Date().toISOString(),
  });

  assert.equal(result.status, 'MONGO_FAILURE');
  assert.equal(result.metadata.mongoStatus, 'FAILED');
  assert.equal(result.metadata.mongoAcknowledged, null);
  assert.equal(result.metadata.extractionFailureCategory, undefined);
});
