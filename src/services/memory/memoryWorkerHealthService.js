const { env } = require('../../config/env');
const memoryJobService = require('./memoryJobService');
const { processMemoryJobs } = require('../../services/workers/memoryWorkerService');

async function getWorkerHealth() {
  const queueStatus = await memoryJobService.countQueueStatusWithStale();
  const pendingThresholdMs = 30000;
  const pendingJobs = queueStatus.pending || 0;
  const warnings = [];

  if (pendingJobs > 0) {
    const oldestPending = await require('../../models/MemoryJob')
      .findOne({ status: 'pending' })
      .sort({ createdAt: 1 })
      .lean()
      .catch(() => null);

    if (oldestPending && Date.now() - new Date(oldestPending.createdAt).getTime() > pendingThresholdMs) {
      warnings.push('Pending memory jobs older than 30 seconds detected');
    }
  }

  return {
    queueStatus,
    warnings,
  };
}

async function ensureWorkerProcessing(limit = 50) {
  // try to process pending jobs immediately
  const result = await processMemoryJobs(limit);
  // attempt to reset any stale processing jobs older than configured timeout
  try {
    const staleReset = await memoryJobService.resetStaleProcessingJobs(env.memoryProcessingStaleMs || 10 * 60 * 1000);
    if (staleReset && staleReset.resetCount > 0) {
      console.warn('reset stale processing jobs:', staleReset.resetCount);
    }
  } catch (e) {
    console.warn('ensureWorkerProcessing: failed to reset stale jobs', e && e.message);
  }
  return result;
}

module.exports = { getWorkerHealth, ensureWorkerProcessing };