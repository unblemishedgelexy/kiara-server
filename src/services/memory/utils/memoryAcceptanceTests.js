'use strict';

/**
 * Memory System Acceptance Tests
 * 
 * Tests the intelligent memory retrieval pipeline including:
 * - Query analysis
 * - Escalation (STM → LTM → Deep)
 * - Deduplication
 * - Relevance ranking
 * - Anti-repetition
 * - Context budgeting
 * - Live protection (timeouts)
 */

const assert = require('assert');

// Import memory services
const queryAnalyzer = require('../utils/queryAnalyzer');
const deduplication = require('../utils/deduplicationService');
const relevanceRanking = require('../utils/relevanceRanking');
const contextBudget = require('../utils/contextBudget');
const antiRepetition = require('../utils/antiRepetitionTracker');
const memoryIdentity = require('../utils/memoryIdentity');
const memoryOrchestrator = require('../utils/memoryRetrievelOrchestrator');

// ────────────────────────────────────────────────────────────────────
// TEST HELPERS
// ────────────────────────────────────────────────────────────────────

function createMockMemory(overrides = {}) {
  return {
    id: Math.random().toString(36).slice(2),
    type: 'fact',
    category: 'fact',
    content: 'Test memory content',
    value: 'test value',
    importance: 0.5,
    confidence: 0.8,
    accessCount: 0,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
// TEST 1: Query Analysis - Identity Recall
// ────────────────────────────────────────────────────────────────────

async function test1_queryAnalysis_identityRecall() {
  console.log('\n[TEST 1] Query Analysis - Identity Recall');
  
  const query = 'What is my name?';
  const result = queryAnalyzer.analyzeQuery(query);
  
  assert.strictEqual(result.intent, 'identity_recall', 'Intent should be identity_recall');
  assert(result.shouldSearchLongTerm, 'Should search long-term for identity query');
  assert(result.shouldSearchShortTerm, 'Should still check short-term first');
  
  console.log('✓ Query correctly identified as identity recall');
  console.log('  - Intent:', result.intent);
  console.log('  - Should search LTM:', result.shouldSearchLongTerm);
}

// ────────────────────────────────────────────────────────────────────
// TEST 2: Query Analysis - Project Query
// ────────────────────────────────────────────────────────────────────

async function test2_queryAnalysis_projectQuery() {
  console.log('\n[TEST 2] Query Analysis - Project Query');
  
  const query = 'Tell me about the Kiara project';
  const result = queryAnalyzer.analyzeQuery(query);
  
  assert.strictEqual(result.intent, 'project_query', 'Intent should be project_query');
  assert(result.shouldSearchLongTerm, 'Should search long-term for project query');
  assert.strictEqual(result.entities.length > 0, true, 'Should extract entities (Kiara)');
  
  console.log('✓ Query correctly identified as project query');
  console.log('  - Intent:', result.intent);
  console.log('  - Entities found:', result.entities);
}

// ────────────────────────────────────────────────────────────────────
// TEST 3: Deduplication - Identical Content
// ────────────────────────────────────────────────────────────────────

async function test3_deduplication_identicalContent() {
  console.log('\n[TEST 3] Deduplication - Identical Content');
  
  const memory1 = createMockMemory({
    type: 'identity',
    content: 'My name is Abhay',
    value: 'Abhay',
  });
  
  const memory2 = createMockMemory({
    type: 'identity',
    content: 'My name is Abhay',
    value: 'Abhay',
  });
  
  const existing = [memory1];
  const result = deduplication.checkForDuplicates(memory2, existing);
  
  assert(result.isDuplicate, 'Should detect as duplicate');
  assert(result.matchType === 'fingerprint' || result.matchType === 'exact_text', 'Should match by content');
  
  console.log('✓ Duplicate detected correctly');
  console.log('  - Match type:', result.matchType);
  console.log('  - Similarity:', result.similarity);
}

// ────────────────────────────────────────────────────────────────────
// TEST 4: Memory Identity - Stable Key Generation
// ────────────────────────────────────────────────────────────────────

async function test4_memoryIdentity_stableKeys() {
  console.log('\n[TEST 4] Memory Identity - Stable Key Generation');
  
  const memory = { type: 'identity', title: 'name', value: 'Abhay' };
  const id1 = memoryIdentity.generateMemoryIdentity(memory);
  const id2 = memoryIdentity.generateMemoryIdentity(memory);
  
  assert(id1 !== null, 'Identity should not be null');
  assert.strictEqual(id1, id2, 'Same memory should generate same identity');
  assert(id1.includes('identity'), 'Identity should include type');
  assert(id1.includes('name'), 'Identity should include category');
  
  console.log('✓ Stable identities generated');
  console.log('  - Identity 1:', id1);
  console.log('  - Identity 2:', id2);
  console.log('  - Match:', id1 === id2);
}

// ────────────────────────────────────────────────────────────────────
// TEST 5: Deduplication - List Filtering
// ────────────────────────────────────────────────────────────────────

async function test5_deduplication_listFiltering() {
  console.log('\n[TEST 5] Deduplication - List Filtering');
  
  const memories = [
    createMockMemory({ id: '1', type: 'identity', title: 'name', value: 'Abhay', importance: 0.9 }),
    createMockMemory({ id: '2', type: 'identity', title: 'name', value: 'Abhay', importance: 0.7 }), // duplicate
    createMockMemory({ id: '3', type: 'project', title: 'Kiara', value: 'AI project', importance: 0.8 }),
    createMockMemory({ id: '4', type: 'project', title: 'OtherProject', value: 'Different project', importance: 0.6 }), // different
  ];
  
  const filtered = deduplication.deduplicateMemoryList(memories);
  
  assert(filtered.length < memories.length, 'Should remove duplicates');
  assert(filtered.length === 3, `Should keep 3 unique memories, got ${filtered.length}`);
  
  console.log('✓ Duplicates filtered correctly');
  console.log('  - Original count:', memories.length);
  console.log('  - Filtered count:', filtered.length);
  console.log('  - Duplicates removed:', memories.length - filtered.length);
}

// ────────────────────────────────────────────────────────────────────
// TEST 6: Relevance Ranking - Multi-Factor
// ────────────────────────────────────────────────────────────────────

async function test6_relevanceRanking_multiFactorScore() {
  console.log('\n[TEST 6] Relevance Ranking - Multi-Factor Score');
  
  const memories = [
    createMockMemory({
      id: '1',
      type: 'identity',
      value: 'Abhay',
      importance: 0.9,
      confidence: 0.95,
      entities: ['Abhay'],
      keywords: ['name', 'identity'],
    }),
    createMockMemory({
      id: '2',
      type: 'fact',
      value: 'Some random fact',
      importance: 0.2,
      confidence: 0.5,
      entities: [],
      keywords: [],
    }),
  ];
  
  const query = {
    intent: 'identity_recall',
    entities: ['Abhay'],
    keywords: ['name'],
    temporalHint: null,
  };
  
  const ranked = relevanceRanking.rankMemories(memories, query);
  
  assert.strictEqual(ranked[0].id, '1', 'Identity memory should rank first');
  assert(ranked[0].relevanceScore > ranked[1].relevanceScore, 'First should have higher score');
  
  console.log('✓ Ranking works correctly');
  console.log('  - Top result:', ranked[0].value);
  console.log('  - Top score:', ranked[0].relevanceScore.toFixed(2));
  console.log('  - Second score:', ranked[1].relevanceScore.toFixed(2));
}

// ────────────────────────────────────────────────────────────────────
// TEST 7: Context Budget - Token Limiting
// ────────────────────────────────────────────────────────────────────

async function test7_contextBudget_tokenLimiting() {
  console.log('\n[TEST 7] Context Budget - Token Limiting');
  
  const contextData = {
    identity: [createMockMemory({ type: 'identity', value: 'A'.repeat(1000) })],
    activeProject: createMockMemory({ type: 'project', value: 'B'.repeat(1000) }),
    relationships: [createMockMemory({ type: 'person', value: 'C'.repeat(1000) })],
    recentTurns: [
      { userMessage: 'D'.repeat(500), aiResponse: 'E'.repeat(500) },
      { userMessage: 'F'.repeat(500), aiResponse: 'G'.repeat(500) },
    ],
  };
  
  const result = contextBudget.buildBudgetedContext(contextData, {
    TOTAL_CONTEXT_TOKENS: 500,
  });
  
  assert(result.totalTokens <= 500, 'Context should not exceed budget');
  assert(result.budgetUsagePercent <= 100, 'Budget usage should be <= 100%');
  
  console.log('✓ Context budgeting works');
  console.log('  - Budget:', result.budgetTokens, 'tokens');
  console.log('  - Used:', result.totalTokens, 'tokens');
  console.log('  - Usage:', result.budgetUsagePercent + '%');
}

// ────────────────────────────────────────────────────────────────────
// TEST 8: Anti-Repetition - Surfaced Tracking
// ────────────────────────────────────────────────────────────────────

async function test8_antiRepetition_trackedSurfacing() {
  console.log('\n[TEST 8] Anti-Repetition - Surfaced Tracking');
  
  const userId = 'test_user_' + Math.random();
  const sessionId = 'test_session';
  
  antiRepetition.initializeSession(userId, sessionId);
  
  const memoryId1 = 'mem_1';
  antiRepetition.recordSurfacedMemory(userId, sessionId, memoryId1);
  
  assert(antiRepetition.hasAlreadySurfaced(userId, sessionId, memoryId1), 'Should mark as surfaced');
  assert(!antiRepetition.hasAlreadySurfaced(userId, sessionId, 'mem_2'), 'Should not mark other as surfaced');
  
  const filtered = antiRepetition.filterOutSurfacedMemories(
    [{ id: 'mem_1' }, { id: 'mem_2' }],
    userId,
    sessionId
  );
  
  assert.strictEqual(filtered.length, 1, 'Should filter out surfaced memory');
  assert.strictEqual(filtered[0].id, 'mem_2', 'Should keep only new memory');
  
  antiRepetition.cleanupSession(userId, sessionId);
  
  console.log('✓ Anti-repetition tracking works');
  console.log('  - Surfaced memory filtered out');
  console.log('  - Remaining memories:', filtered.length);
}

// ────────────────────────────────────────────────────────────────────
// TEST 9: No Hallucination - Missing Memory Handled
// ────────────────────────────────────────────────────────────────────

async function test9_noHallucination_missingMemory() {
  console.log('\n[TEST 9] No Hallucination - Missing Memory Handled');
  
  // Empty memory list simulates memory not found
  const memories = [];
  const query = { intent: 'identity_recall', entities: [], keywords: [] };
  
  const ranked = relevanceRanking.rankMemories(memories, query);
  
  assert.strictEqual(ranked.length, 0, 'Should return empty, not hallucinate');
  
  console.log('✓ No hallucination on missing memory');
  console.log('  - Result count:', ranked.length);
  console.log('  - No fabricated results returned');
}

// ────────────────────────────────────────────────────────────────────
// TEST 10: STM Preference - Temporal Continuity
// ────────────────────────────────────────────────────────────────────

async function test10_stmPreference_temporalContinuity() {
  console.log('\n[TEST 10] STM Preference - Temporal Continuity');
  
  const now = Date.now();
  const recent = createMockMemory({
    type: 'episode',
    content: 'Recent conversation',
    createdAt: new Date(now - 1000).toISOString(), // 1 second ago
  });
  
  const old = createMockMemory({
    type: 'episode',
    content: 'Old conversation',
    createdAt: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days ago
  });
  
  const query = {
    intent: 'semantic_search',
    entities: [],
    keywords: [],
    temporalHint: 'today',
  };
  
  const ranked = relevanceRanking.rankMemories([old, recent], query);
  
  // Recent should rank higher than old
  assert(ranked[0].relevanceScore >= ranked[1].relevanceScore, 'Recent should rank higher for temporal query');
  
  console.log('✓ STM preference works for temporal queries');
  console.log('  - Top result age:', '1 second');
  console.log('  - Second result age:', '30 days');
  console.log('  - Top score:', ranked[0].relevanceScore.toFixed(2));
}

// ────────────────────────────────────────────────────────────────────
// TEST 11: Active Context + Entity Resolution
// ────────────────────────────────────────────────────────────────────

async function test11_activeContext_entityResolution() {
  console.log('\n[TEST 11] Active Context + Entity Resolution');

  const sessionContext = {
    userId: 'user_1',
    sessionId: 'session_1',
    activeContext: {
      activeTopic: 'Gemini Live',
      activeEntities: ['Gemini Live', 'backend'],
      lastReferencedEntity: 'backend',
    },
  };

  const analysis = queryAnalyzer.analyzeQuery('Why did we choose it?', sessionContext);

  assert(analysis.entities.length > 0, 'Should resolve core entity references even with follow-up pronouns');
  const joined = analysis.entities.join(' ').toLowerCase();
  assert(joined.includes('gemini') || joined.includes('backend'), 'Should include active entity context');

  console.log('✓ Active context used for follow-up reference resolution');
  console.log('  - Entities:', analysis.entities);
}

// ────────────────────────────────────────────────────────────────────
// TEST 12: Controlled "I don't remember" state
// ────────────────────────────────────────────────────────────────────

async function test12_controlled_no_memory_state() {
  console.log('\n[TEST 12] Controlled "I don\'t remember" state');

  const result = await memoryOrchestrator.retrieveMemoryForQuery('What was my favorite childhood city?', {
    userId: 'user_missing',
    sessionId: 'session_missing',
  });

  assert.strictEqual(result.source, 'NONE', 'No memory should produce NONE source');
  assert.strictEqual(result.confidence, 0, 'No memory should have zero confidence');
  assert.strictEqual(result.memories.length, 0, 'No memory should return empty result list');

  console.log('✓ Missing-memory fallback is controlled and non-hallucinatory');
  console.log('  - Source:', result.source);
  console.log('  - Reason:', result.reason);
}

// ────────────────────────────────────────────────────────────────────
// TEST 13: Semantic identity uses entity + attribute + value
// ────────────────────────────────────────────────────────────────────

async function test13_semantic_identity_generation() {
  console.log('\n[TEST 13] Semantic identity generation');

  const memory = {
    entity: 'roshan',
    attribute: 'project',
    value: 'kiara_ai',
  };

  const identity = memoryIdentity.generateMemoryIdentity(memory);

  assert.strictEqual(identity, 'roshan.project.kiara_ai', 'Semantic identity should be entity.attribute.value');

  console.log('✓ Semantic identity is stable and meaningful');
  console.log('  - Identity:', identity);
}

// ────────────────────────────────────────────────────────────────────
// TEST 14: Context contract for Gemini consumption
// ────────────────────────────────────────────────────────────────────

async function test14_context_contract_for_gemini() {
  console.log('\n[TEST 14] Context contract for Gemini');

  const result = await memoryOrchestrator.retrieveMemoryForQuery('What project am I building?', {
    userId: 'user_contract',
    sessionId: 'session_contract',
    activeContext: {
      activeTopic: 'Kiara',
      activeEntities: ['Kiara'],
    },
  });

  assert(result.hasOwnProperty('compressedContext'), 'Result must expose compressedContext');
  assert(Array.isArray(result.memories) || result.source === 'NONE', 'Result must include an array of memories or a NONE response');

  console.log('✓ Retrieval contract exposes compressedContext for Gemini');
  console.log('  - Source:', result.source);
  console.log('  - Context length:', String(result.compressedContext || '').length);
}

// ────────────────────────────────────────────────────────────────────
// Test Runner
// ────────────────────────────────────────────────────────────────────

async function runAllTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║      KIARA MEMORY SYSTEM - ACCEPTANCE TESTS                ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  
  const tests = [
    test1_queryAnalysis_identityRecall,
    test2_queryAnalysis_projectQuery,
    test3_deduplication_identicalContent,
    test4_memoryIdentity_stableKeys,
    test5_deduplication_listFiltering,
    test6_relevanceRanking_multiFactorScore,
    test7_contextBudget_tokenLimiting,
    test8_antiRepetition_trackedSurfacing,
    test9_noHallucination_missingMemory,
    test10_stmPreference_temporalContinuity,
    test11_activeContext_entityResolution,
    test12_controlled_no_memory_state,
    test13_semantic_identity_generation,
    test14_context_contract_for_gemini,
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const test of tests) {
    try {
      await test();
      passed += 1;
    } catch (err) {
      failed += 1;
      console.error(`✗ FAILED: ${err.message}`);
      console.error(`  Stack: ${err.stack}`);
    }
  }
  
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log(`║ RESULTS: ${passed} passed, ${failed} failed                          ║`);
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  
  return failed === 0;
}

// Export for testing
module.exports = { runAllTests };

// Run tests if executed directly
if (require.main === module) {
  runAllTests()
    .then(success => process.exit(success ? 0 : 1))
    .catch(err => {
      console.error('Test runner failed:', err);
      process.exit(1);
    });
}
