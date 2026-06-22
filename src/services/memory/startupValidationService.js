const mongoose = require('mongoose');
const memoryHealthService = require('./memoryHealthService');
const memoryIntegrityService = require('./memoryIntegrityService');
const cacheConsistencyService = require('./cacheConsistencyService');
const sessionContinuityValidator = require('./sessionContinuityValidator');

/**
 * V6.5 Startup Validation Service
 * Performs diagnostics and integrity checks on the memory system during server startup.
 */

async function runStartupChecks() {
  try {
    const checks = {};

    // 1. Health Check
    try {
      const health = await memoryHealthService.getMemoryHealth();
      checks.health = {
        ok: health.mongoConnected && health.redisConnected,
        details: health,
      };
    } catch (err) {
      checks.health = { ok: false, error: err.message };
    }

    // 2. Database Connection Check
    try {
      const connected = mongoose.connection.readyState === 1;
      checks.database = { ok: connected, state: mongoose.connection.readyState };
    } catch (err) {
      checks.database = { ok: false, error: err.message };
    }

    // 3. Sample Integrity Check (scan a random sample of users for issues)
    try {
      const sample = await getSampleUserIds(5);
      const integrityResults = [];
      for (const userId of sample) {
        try {
          const result = await memoryIntegrityService.validateUserMemories(userId);
          integrityResults.push({
            userId,
            issueCount: result.issueCount,
            durationMs: result.durationMs,
            ok: result.issueCount === 0,
          });
        } catch (e) {
          integrityResults.push({ userId, error: e.message, ok: false });
        }
      }
      const allOk = integrityResults.every((r) => r.ok);
      checks.integrity = { ok: allOk, sampleSize: sample.length, results: integrityResults };
    } catch (err) {
      checks.integrity = { ok: false, error: err.message };
    }

    // 4. Cache Consistency Check (sample users)
    try {
      const sample = await getSampleUserIds(3);
      const cacheResults = [];
      for (const userId of sample) {
        try {
          const freshness = await cacheConsistencyService.verifyCacheFreshness(userId);
          cacheResults.push({
            userId,
            valid: freshness.valid,
            continuityCacheExists: freshness.continuityCacheExists,
            bootstrapCacheExists: freshness.bootstrapCacheExists,
            ok: freshness.valid,
          });
        } catch (e) {
          cacheResults.push({ userId, error: e.message, ok: false });
        }
      }
      const allOk = cacheResults.every((r) => r.ok);
      checks.cache = { ok: allOk, sampleSize: sample.length, results: cacheResults };
    } catch (err) {
      checks.cache = { ok: false, error: err.message };
    }

    // Determine overall status
    const allChecksPassed = Object.values(checks).every((check) => check.ok !== false);

    return {
      ok: allChecksPassed,
      timestamp: new Date().toISOString(),
      checks,
    };
  } catch (err) {
    console.error('[STARTUP_VALIDATION] Unhandled error:', err);
    return {
      ok: false,
      error: err.message,
      timestamp: new Date().toISOString(),
    };
  }
}

async function getSampleUserIds(limit) {
  try {
    const Memory = require('../../models/LongTermMemory');
    const docs = await Memory.find({}).select('userId').distinct('userId').limit(limit).exec();
    return docs || [];
  } catch (err) {
    console.warn('Failed to sample user IDs:', err.message);
    return [];
  }
}

module.exports = {
  runStartupChecks,
};
