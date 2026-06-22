const connectDB = require('../src/db/connect');
const { env } = require('../src/config/env');
const redisService = require('../src/services/infrastructure/redisService');
const memoryVerificationService = require('../src/services/memory/memoryVerificationService');
const sessionBootstrapService = require('../src/services/memory/sessionBootstrapService');
const systemPromptBuilderService = require('../src/services/memory/systemPromptBuilderService');
const continuityRestorationEngine = require('../src/services/memory/continuityRestorationEngine');
const memoryPipelineService = require('../src/services/live/geminiService') ? null : require('../src/services/memory/memoryPipelineService');
const memoryStorageService = require('../src/services/memory/memoryStorageService');

async function ensureDependencies() {
  console.log('[TEST] Connecting to MongoDB...');
  const ok = await connectDB();
  if (!ok) {
    console.error('[TEST] MongoDB connection failed. Aborting tests.');
    process.exit(2);
  }

  try {
    await redisService.initRedis();
    console.log('[TEST] Redis connected');
  } catch (e) {
    console.warn('[TEST] Redis connection failed; continuing if tests can run without Redis', e.message || e);
  }
}

async function runTest(name, fn) {
  process.stdout.write(`[TEST] ${name} ... `);
  try {
    const result = await fn();
    process.stdout.write('OK\n');
    return { name, ok: true, result };
  } catch (err) {
    process.stdout.write('FAIL\n');
    console.error(`[TEST] ${name} error:`, err && err.message ? err.message : err);
    return { name, ok: false, error: err };
  }
}

async function testIdentityRecall() {
  const userId = 'test-memory-identity';
  const text = 'My name is Aurora.';
  await memoryVerificationService.verifyMemoryLifecycle(userId, text).catch(() => null);
  const recall = await memoryVerificationService.verifyIdentityRecall(userId, 'Aurora');
  if (!recall || !recall.ok) throw new Error('identity recall failed');
  return recall;
}

async function testRelationshipRecall() {
  const userId = 'test-memory-rel';
  const text = 'My best friend is Aman.';
  const r = await memoryVerificationService.runEndToEndTest(userId, text);
  if (!r || !r.ok) throw new Error('relationship recall failed');
  return r;
}

async function testProjectRecall() {
  const userId = 'test-memory-project';
  const text = 'I work on Project Zephyr with Lina.';
  await memoryVerificationService.verifyMemoryLifecycle(userId, text).catch(() => null);
  const recall = await memoryVerificationService.verifyProjectRecall(userId, 'Zephyr');
  if (!recall || !recall.ok) throw new Error('project recall failed');
  return recall;
}

async function testGoalRecall() {
  const userId = 'test-memory-goal';
  const text = 'I have a goal to learn Rust.';
  await memoryVerificationService.verifyMemoryLifecycle(userId, text).catch(() => null);
  const recall = await memoryVerificationService.verifyGoalRecall(userId, 'Rust');
  if (!recall || !recall.ok) throw new Error('goal recall failed');
  return recall;
}

async function testBootstrapAndPrompt() {
  const userId = 'test-memory-bootstrap';
  const text = 'I work on Project Zephyr with Lina.';
  await memoryVerificationService.verifyMemoryLifecycle(userId, text).catch(() => null);
  const bootstrap = await sessionBootstrapService.buildSessionBootstrapContext(userId, true);
  const prompt = await systemPromptBuilderService.buildSystemPrompt(userId);
  if (!bootstrap || !prompt) throw new Error('bootstrap or prompt build failed');
  return { bootstrap, prompt };
}

async function testContinuityPacket() {
  const userId = 'test-memory-continuity';
  const text = 'I have a goal to learn Rust.';
  await memoryVerificationService.verifyMemoryLifecycle(userId, text).catch(() => null);
  const packet = await continuityRestorationEngine.buildContinuityPacket(userId);
  if (!packet) throw new Error('continuity packet failed');
  return packet;
}

async function testCrossUserIsolation() {
  const userA = 'isolation-user-a';
  const userB = 'isolation-user-b';
  const textA = 'My secret project is Project Aardvark.';
  await memoryVerificationService.verifyMemoryLifecycle(userA, textA).catch(() => null);
  const packetB = await continuityRestorationEngine.buildContinuityPacket(userB);
  const contains = JSON.stringify(packetB || {}).toLowerCase().includes('project aardvark');
  if (contains) throw new Error('cross-user leak detected');
  return { isolated: true };
}

async function seedBenchmark() {
  const users = 10; // reduced by default; change to 100 for heavier runs
  const perUser = 100; // total 1000 memories default
  for (let u = 0; u < users; u++) {
    const userId = `bench-user-${u}`;
    for (let i = 0; i < perUser; i++) {
      const text = `Benchmark memory ${i} for ${userId}`;
      try {
        await memoryStorageService.saveMemory({ userId, category: 'episodic', memory: text, tags: [], importanceScore: 0.5, source: 'benchmark' });
      } catch (e) {
        // continue
      }
    }
  }
  return { users, perUser };
}

async function runAll() {
  await ensureDependencies();
  const results = [];
  results.push(await runTest('Identity Recall', testIdentityRecall));
  results.push(await runTest('Relationship Recall', testRelationshipRecall));
  results.push(await runTest('Project Recall', testProjectRecall));
  results.push(await runTest('Goal Recall', testGoalRecall));
  results.push(await runTest('Bootstrap & Prompt', testBootstrapAndPrompt));
  results.push(await runTest('Continuity Packet', testContinuityPacket));
  results.push(await runTest('Cross User Isolation', testCrossUserIsolation));
  results.push(await runTest('Seed Benchmark (smaller)', seedBenchmark));

  const failed = results.filter((r) => !r.ok);
  console.log('\n[TEST SUMMARY]');
  console.log('Total tests:', results.length, 'Failed:', failed.length);
  if (failed.length) process.exitCode = 3;
  else process.exitCode = 0;
}

runAll().catch((err) => {
  console.error('[TEST] fatal error', err && err.message ? err.message : err);
  process.exit(4);
});
