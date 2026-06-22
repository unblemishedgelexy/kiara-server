/**
 * Memory Accuracy Service
 * Measures real memory recall accuracy across categories
 * Target: 95%+ recall accuracy
 */

const memoryProfileService = require('./memoryProfileService');
const systemPromptBuilderService = require('./systemPromptBuilderService');
const memoryRetrievalHierarchy = require('./memoryRetrievalHierarchy');
const personIdentityResolver = require('./personIdentityResolver');
const redisService = require('../infrastructure/redisService');

/**
 * Test flow:
 * 1. Save memory
 * 2. Retrieve from LTM
 * 3. Rebuild profile
 * 4. Build prompt
 * 5. Verify Gemini receives context
 */

class MemoryAccuracyAudit {
  constructor() {
    this.results = {
      testId: `audit_${Date.now()}`,
      timestamp: new Date().toISOString(),
      tests: [],
      summary: {
        total: 0,
        passed: 0,
        failed: 0,
        categories: {},
      },
    };
  }

  addResult(test) {
    this.results.tests.push({
      ...test,
      timestamp: new Date().toISOString(),
    });

    this.results.summary.total += 1;

    if (test.passed) {
      this.results.summary.passed += 1;
    } else {
      this.results.summary.failed += 1;
    }

    // Track by category
    const cat = test.category || 'unknown';
    if (!this.results.summary.categories[cat]) {
      this.results.summary.categories[cat] = { passed: 0, failed: 0 };
    }
    if (test.passed) {
      this.results.summary.categories[cat].passed += 1;
    } else {
      this.results.summary.categories[cat].failed += 1;
    }
  }

  getAccuracy() {
    return this.results.summary.total === 0
      ? 0
      : (this.results.summary.passed / this.results.summary.total) * 100;
  }

  getSummary() {
    return {
      ...this.results,
      accuracyPercent: this.getAccuracy().toFixed(2),
      qualityStatus: this.getAccuracy() >= 95 ? 'PASS' : 'FAIL',
    };
  }
}

/**
 * Run identity recall test
 * Save "My friend is Aman" → Verify Aman appears in prompt
 */
async function testIdentityRecall(userId, testName = 'Aman') {
  const audit = new MemoryAccuracyAudit();
  const Relationship = require('../../models/RelationshipMemory');
  const Person = require('../../models/PersonProfile');

  try {
    // 1. Save relationship memory
    const savedRel = await Relationship.create({
      userId,
      personName: testName,
      memory: `My friend is ${testName}`,
      category: 'relationship',
      importanceScore: 0.9,
      source: 'test_accuracy_audit',
      tags: ['test', 'accuracy_audit'],
    });

    audit.addResult({
      step: 'SAVE_RELATIONSHIP',
      category: 'identity',
      passed: Boolean(savedRel._id),
      details: { memoryId: String(savedRel._id) },
    });

    // 2. Check if Person profile created
    const person = await Person.findOne({ userId, name: testName }).lean();
    const personCreated = Boolean(person);

    audit.addResult({
      step: 'PERSON_PROFILE_CHECK',
      category: 'identity',
      passed: personCreated,
      details: { profileExists: personCreated, confidence: person?.confidence || null },
    });

    // 3. Rebuild profile
    const profile = await memoryProfileService.rebuildMemoryProfile(userId);
    const profileRebuilt = Boolean(profile);

    audit.addResult({
      step: 'PROFILE_REBUILD',
      category: 'identity',
      passed: profileRebuilt,
      details: { profileId: profile?._id, relationshipSummary: profile?.relationshipSummary?.slice(0, 100) },
    });

    // 4. Build system prompt
    const prompt = await systemPromptBuilderService.buildSystemPrompt(userId, { tokenBudget: 2000 });
    const promptBuilt = Boolean(prompt?.systemPrompt);
    const mentionsName = prompt?.systemPrompt?.includes(testName) || false;

    audit.addResult({
      step: 'PROMPT_BUILD',
      category: 'identity',
      passed: promptBuilt && mentionsName,
      details: {
        promptLength: prompt?.systemPrompt?.length || 0,
        mentionsName,
        tokenCount: prompt?.tokenCount,
      },
    });

    // 5. Retrieve from hierarchy
    const retrieved = await memoryRetrievalHierarchy.retrieveMemoriesWithContext(userId, 'my friend', { limit: 10 });
    const retrievedMemories = (retrieved && Array.isArray(retrieved.memories)) ? retrieved.memories : [];
    const foundInRetrieval = retrievedMemories.some((m) =>
      String(m.memory || m.content || '').includes(testName)
    );

    audit.addResult({
      step: 'HIERARCHY_RETRIEVAL',
      category: 'identity',
      passed: foundInRetrieval,
      details: { retrievedCount: retrievedMemories.length, foundInRetrieval, retrieval: retrieved },
    });

    // Cleanup test data
    await Relationship.deleteOne({ _id: savedRel._id }).catch(() => null);

    return audit.getSummary();
  } catch (err) {
    audit.addResult({
      step: 'ERROR',
      category: 'identity',
      passed: false,
      details: { error: err?.message || String(err) },
    });
    return audit.getSummary();
  }
}

/**
 * Run relationship recall test
 */
async function testRelationshipRecall(userId) {
  const audit = new MemoryAccuracyAudit();
  const Relationship = require('../../models/RelationshipMemory');

  try {
    const testMemory = 'Aman loves coding and is a great developer';

    // Save relationship
    const saved = await Relationship.create({
      userId,
      personName: 'Aman',
      memory: testMemory,
      category: 'relationship',
      importanceScore: 0.85,
      source: 'test_accuracy_audit',
      tags: ['test', 'relationship'],
    });

    audit.addResult({
      step: 'SAVE_RELATIONSHIP',
      category: 'relationship',
      passed: Boolean(saved._id),
      details: { memoryId: String(saved._id) },
    });

    // Rebuild profile
    const profile = await memoryProfileService.rebuildMemoryProfile(userId);

    audit.addResult({
      step: 'PROFILE_REBUILD',
      category: 'relationship',
      passed: Boolean(profile),
      details: { profileId: profile?._id },
    });

    // Check if relationship appears in summary
    const summary = profile?.relationshipSummary || '';
    const appearsInSummary = summary.includes('Aman') || summary.includes('developer');

    audit.addResult({
      step: 'RELATIONSHIP_SUMMARY',
      category: 'relationship',
      passed: appearsInSummary,
      details: { summaryLength: summary.length, mentionsName: summary.includes('Aman') },
    });

    // Build prompt
    const prompt = await systemPromptBuilderService.buildSystemPrompt(userId, { tokenBudget: 2000 });
    const mentionsInPrompt = prompt?.systemPrompt?.includes('Aman') || false;

    audit.addResult({
      step: 'PROMPT_INJECTION',
      category: 'relationship',
      passed: mentionsInPrompt,
      details: { tokenCount: prompt?.tokenCount, mentionsName: mentionsInPrompt },
    });

    // Cleanup
    await Relationship.deleteOne({ _id: saved._id }).catch(() => null);

    return audit.getSummary();
  } catch (err) {
    audit.addResult({
      step: 'ERROR',
      category: 'relationship',
      passed: false,
      details: { error: err?.message },
    });
    return audit.getSummary();
  }
}

/**
 * Run project recall test
 */
async function testProjectRecall(userId) {
  const audit = new MemoryAccuracyAudit();
  const LongTermMemory = require('../../models/LongTermMemory');

  try {
    const testMemory = 'Working on Kiara AI project for memory system';

    // Save project memory
    const saved = await LongTermMemory.create({
      userId,
      category: 'project',
      memory: testMemory,
      importanceScore: 0.8,
      source: 'test_accuracy_audit',
      tags: ['test', 'project'],
    });

    audit.addResult({
      step: 'SAVE_PROJECT',
      category: 'project',
      passed: Boolean(saved._id),
      details: { memoryId: String(saved._id) },
    });

    // Rebuild profile
    const profile = await memoryProfileService.rebuildMemoryProfile(userId);

    audit.addResult({
      step: 'PROFILE_REBUILD',
      category: 'project',
      passed: Boolean(profile),
      details: { hasProjectSummary: Boolean(profile?.projectSummary) },
    });

    // Check if project appears in summary
    const projectSummary = profile?.projectSummary || '';
    const appearsInSummary = projectSummary.includes('Kiara') || projectSummary.includes('memory');

    audit.addResult({
      step: 'PROJECT_SUMMARY',
      category: 'project',
      passed: appearsInSummary,
      details: { summaryLength: projectSummary.length, mentionsKiara: projectSummary.includes('Kiara') },
    });

    // Build prompt
    const prompt = await systemPromptBuilderService.buildSystemPrompt(userId, { tokenBudget: 2000 });
    const mentionsInPrompt = prompt?.systemPrompt?.includes('Kiara') || false;

    audit.addResult({
      step: 'PROMPT_INJECTION',
      category: 'project',
      passed: mentionsInPrompt,
      details: { mentionsKiara: mentionsInPrompt },
    });

    // Cleanup
    await LongTermMemory.deleteOne({ _id: saved._id }).catch(() => null);

    return audit.getSummary();
  } catch (err) {
    audit.addResult({
      step: 'ERROR',
      category: 'project',
      passed: false,
      details: { error: err?.message },
    });
    return audit.getSummary();
  }
}

/**
 * Run goal recall test
 */
async function testGoalRecall(userId) {
  const audit = new MemoryAccuracyAudit();
  const LongTermMemory = require('../../models/LongTermMemory');

  try {
    const testMemory = 'Goal: Build production-ready AI assistant with perfect memory';

    const saved = await LongTermMemory.create({
      userId,
      category: 'goal',
      memory: testMemory,
      importanceScore: 0.95,
      source: 'test_accuracy_audit',
      tags: ['test', 'goal'],
    });

    audit.addResult({
      step: 'SAVE_GOAL',
      category: 'goal',
      passed: Boolean(saved._id),
      details: { memoryId: String(saved._id) },
    });

    const profile = await memoryProfileService.rebuildMemoryProfile(userId);

    audit.addResult({
      step: 'PROFILE_REBUILD',
      category: 'goal',
      passed: Boolean(profile),
      details: { hasGoalSummary: Boolean(profile?.goalSummary) },
    });

    const goalSummary = profile?.goalSummary || '';
    const appearsInSummary = goalSummary.includes('production') || goalSummary.includes('memory');

    audit.addResult({
      step: 'GOAL_SUMMARY',
      category: 'goal',
      passed: appearsInSummary,
      details: { summaryLength: goalSummary.length },
    });

    const prompt = await systemPromptBuilderService.buildSystemPrompt(userId, { tokenBudget: 2000 });
    const mentionsInPrompt = prompt?.systemPrompt?.includes('production') || false;

    audit.addResult({
      step: 'PROMPT_INJECTION',
      category: 'goal',
      passed: mentionsInPrompt,
      details: { mentionsGoal: mentionsInPrompt },
    });

    await LongTermMemory.deleteOne({ _id: saved._id }).catch(() => null);

    return audit.getSummary();
  } catch (err) {
    audit.addResult({
      step: 'ERROR',
      category: 'goal',
      passed: false,
      details: { error: err?.message },
    });
    return audit.getSummary();
  }
}

/**
 * Run full end-to-end accuracy audit
 */
async function runFullAccuracyAudit(userId) {
  const startMs = Date.now();
  const results = {
    testId: `full_audit_${Date.now()}`,
    timestamp: new Date().toISOString(),
    userId,
    tests: {},
    overall: {
      total: 0,
      passed: 0,
      failed: 0,
      accuracyPercent: 0,
    },
    latencyMs: 0,
  };

  try {
    // Run each category test
    const identityTest = await testIdentityRecall(userId);
    results.tests.identity = identityTest;

    const relationshipTest = await testRelationshipRecall(userId);
    results.tests.relationship = relationshipTest;

    const projectTest = await testProjectRecall(userId);
    results.tests.project = projectTest;

    const goalTest = await testGoalRecall(userId);
    results.tests.goal = goalTest;

    // Aggregate results
    const allTests = [identityTest, relationshipTest, projectTest, goalTest];
    allTests.forEach((test) => {
      results.overall.total += test.summary.total;
      results.overall.passed += test.summary.passed;
      results.overall.failed += test.summary.failed;
    });

    results.overall.accuracyPercent =
      results.overall.total === 0
        ? 0
        : ((results.overall.passed / results.overall.total) * 100).toFixed(2);

    results.qualityStatus = results.overall.accuracyPercent >= 95 ? 'PASS ✅' : 'FAIL ❌';
    results.latencyMs = Date.now() - startMs;

    return results;
  } catch (err) {
    results.error = err?.message;
    results.qualityStatus = 'ERROR ❌';
    results.latencyMs = Date.now() - startMs;
    return results;
  }
}

module.exports = {
  testIdentityRecall,
  testRelationshipRecall,
  testProjectRecall,
  testGoalRecall,
  runFullAccuracyAudit,
  MemoryAccuracyAudit,
};
