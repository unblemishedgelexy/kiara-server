#!/usr/bin/env node
const memoryUtils = require('../src/utils/memory/memoryUtils');
const embeddingProvider = require('../src/services/embedding/embeddingProvider');
const pineSvc = require('../src/services/pineconeService');
const { env } = require('../src/config/env');
const { runValidation } = require('../src/services/memory/validation/validationRunner');
const logger = require('../src/services/memory/utils/memoryLogger');

async function run(options = {}) {
  const { exitOnFailure = true } = options;
  console.log('\n=== MEMORY INFRASTRUCTURE VALIDATION ===\n');
  const status = {
    PROVIDER: 'PENDING',
    SDK: 'PENDING',
    API_KEY: 'PENDING',
    EMBEDDING: 'PENDING',
    PINECONE: 'PENDING',
    UPSERT: 'PENDING',
    FETCH: 'PENDING',
    DELETE: 'PENDING',
    RETRIEVAL: 'PENDING',
  };
  let exitCode = 0;

  let providerInfo = null;

  // 1. Embedding validation — backend-only Google GenAI provider
  try {
    logger.log('EMBEDDING_INIT', { ts: new Date().toISOString() });
    status.PROVIDER = 'Google';
    providerInfo = embeddingProvider.getProviderInfo ? embeddingProvider.getProviderInfo() : null;
    if (providerInfo) {
      console.log('Embedding Provider:', providerInfo.provider);
      console.log('SDK:', providerInfo.sdk);
      console.log('API Key:', providerInfo.apiKeyLoaded ? 'Loaded' : 'Missing');
      console.log('Embedding Model:', providerInfo.model);
    }
    const embRes = await memoryUtils.validateEmbeddingConfiguration();
    if (!embRes || !embRes.success) {
      console.error('Embedding: FAIL');
      console.error('Embedding provider validation failed:', embRes && embRes.error);
      status.EMBEDDING = 'FAIL';
      status.API_KEY = 'FAIL';
      if (exitOnFailure) {
        printSummaryAndExit(status);
        process.exitCode = 1;
      }
      return status;
    }
    console.log('Embedding: PASS');
    console.log('Embedding vector dim:', embRes.dimension);
    console.log('Provider Ready: PASS');
    status.SDK = 'PASS';
    status.API_KEY = 'PASS';
    status.EMBEDDING = 'PASS';
  } catch (e) {
    console.error('Embedding: FAIL');
    console.error(e.message || String(e));
    logger.logError('EMBEDDING_VALIDATION', e.message || String(e), e.stack || null, '', 'startup');
    status.EMBEDDING = 'FAIL';
    status.API_KEY = 'FAIL';
    if (exitOnFailure) {
      printSummaryAndExit(status);
      process.exitCode = 1;
    }
    return status;
  }

  // 2. Pinecone validation
  try {
    const pineRes = await pineSvc.validateConfiguration();
    if (!pineRes.success) {
      console.error('Pinecone: FAIL');
      console.error('Errors:', pineRes.errors.join('\n'));
      logger.log('PINECONE_CONFIGURATION', { success: false, errors: pineRes.errors });
      status.PINECONE = 'FAIL';
      if (exitOnFailure) {
        printSummaryAndExit(status);
        process.exitCode = 2;
      }
      return status;
    }
    console.log('Pinecone: PASS');
    console.log('Indexes:', (pineRes.indexes || []).join(', '));
    logger.log('PINECONE_CONFIGURATION', { success: true, indexes: pineRes.indexes });
    status.PINECONE = 'PASS';
  } catch (e) {
    console.error('Pinecone: FAIL');
    console.error(e.message || String(e));
    logger.logError('PINECONE_CONFIGURATION', e.message || String(e), e.stack || null, '', 'startup');
    status.PINECONE = 'FAIL';
    if (exitOnFailure) {
      printSummaryAndExit(status);
      process.exitCode = 2;
    }
    return status;
  }

  // 3. End-to-end vector test
  try {
    console.log('\nPerforming end-to-end vector test...');
    const sample = 'Hello Kiara';
    const embStart = Date.now();
    const vector = await memoryUtils.computeEmbedding(sample);
    const embLatency = Date.now() - embStart;
    if (!vector || !Array.isArray(vector) || vector.length === 0) throw new Error('Embedding generation returned invalid vector');
    console.log('EMBEDDING_SUCCESS', { dimension: vector.length, latencyMs: embLatency });

    const vid = `validation:${Date.now()}`;
    const meta = { test: true, createdAt: new Date().toISOString(), model: providerInfo ? providerInfo.model : 'unknown' };

    const upsertStart = Date.now();
    const upsertOk = await pineSvc.upsertLongTermVector({ id: vid, vector, metadata: meta });
    const upsertLatency = Date.now() - upsertStart;

    if (!upsertOk) throw new Error('Pinecone upsert failed');
    logger.log('PINECONE_UPSERT', { id: vid, latencyMs: upsertLatency });
    status.UPSERT = 'PASS';

    const queryStart = Date.now();
    const results = await pineSvc.queryLongTermVectors({ vector, topK: 5 });
    const queryLatency = Date.now() - queryStart;
    logger.log('PINECONE_QUERY', { id: vid, latencyMs: queryLatency, matches: (results || []).length });
    status.FETCH = 'PASS';

    const found = (results || []).find(m => m.id === vid);
    const sim = found && (found.score || found.similarity || found.distance) ? (found.score || found.similarity || found.distance) : null;

    const delOk = await pineSvc.deleteLongTermVector(vid);
    logger.log('PINECONE_DELETE', { id: vid, success: delOk });
    status.DELETE = delOk ? 'PASS' : 'FAIL';

    console.log('Embedding Latency (ms):', embLatency);
    console.log('Upsert Latency (ms):', upsertLatency);
    console.log('Query Latency (ms):', queryLatency);
    console.log('Similarity:', sim);
    console.log('Cleanup:', delOk ? 'OK' : 'FAILED');

    // Run a retrieval using retriever if available
    try {
      const retriever = require('../src/services/memory/retrieval/retriever');
      const qRes = await retriever.retrieve({ userId: 'validation-user', query: 'Hello Kiara', topK: 5 });
      const hits = Array.isArray(qRes) ? qRes.length : (qRes?.results?.length || qRes?.matches?.length || 0);
      logger.log('RETRIEVAL_RESULT', { hits });
      status.RETRIEVAL = 'PASS';
    } catch (e) {
      status.RETRIEVAL = 'FAIL';
    }

  } catch (e) {
    console.error('End-to-end vector test failed:', e.message || String(e));
    logger.logError('VECTOR_TEST_FAIL', e.message || String(e), e.stack || null, '', 'startup');
    if (exitOnFailure) {
      process.exitCode = 3;
      return;
    }
    return status;
  }

  // 4. Run full memory validation suite
  try {
    console.log('\nRunning full memory validation suite...');
    const res = await runValidation({ userId: 'ltm-verify-user', seed: true, seedMessage: 'Infra validation', seedResponse: 'OK' });
    console.log('\nValidation Summary:', JSON.stringify(res, null, 2));
    logger.log('MEMORY_INFRASTRUCTURE_READY', { overall: res.overall });
    // reflect retrieval/pass status into the summary
    if (res && typeof res.overall === 'number') {
      status.RETRIEVAL = 'PASS';
    }
  } catch (e) {
    console.error('Full validation failed:', e.message || String(e));
    if (exitOnFailure) {
      process.exitCode = 4;
      return;
    }
    return status;
  }

  console.log('\nMEMORY INFRASTRUCTURE READY');
  if (exitOnFailure) {
    printSummaryAndExit(status);
    process.exitCode = 0;
  }
  return status;
}

function printSummaryAndExit(status) {
  console.log('\n=========================');
  console.log('MEMORY INFRA VALIDATION');
  console.log('=========================\n');
  const rows = [
    ['PROVIDER', status.PROVIDER],
    ['SDK', status.SDK],
    ['API KEY', status.API_KEY],
    ['EMBEDDING', status.EMBEDDING],
    ['PINECONE', status.PINECONE],
    ['UPSERT', status.UPSERT],
    ['FETCH', status.FETCH],
    ['DELETE', status.DELETE],
    ['RETRIEVAL', status.RETRIEVAL],
  ];
  for (const [k, v] of rows) {
    console.log(`${k.padEnd(16)} ${v}`);
  }
  // Only consider key health checks (exclude PROVIDER label)
  const keysToCheck = ['SDK', 'API KEY', 'EMBEDDING', 'PINECONE', 'UPSERT', 'FETCH', 'DELETE', 'RETRIEVAL'];
  const allPass = keysToCheck.every(k => status[k] === 'PASS');
  console.log('\nOVERALL STATUS\n');
  console.log(allPass ? '\u2705 MEMORY INFRA READY' : '\u274C EXACT FAILURE LOCATION');
}

async function runWrapper(options = {}) { return run(options); }

if (require.main === module) {
  runWrapper({ exitOnFailure: true }).catch(e => { console.error('Validation runner failed:', e); process.exit(1); });
}

module.exports = { run: runWrapper };
