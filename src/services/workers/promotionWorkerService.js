const PromotionJob = require('../../models/PromotionJob');
const LongTermMemory = require('../../models/LongTermMemory');
const { env } = require('../../config/env');

const BACKOFF_MS = [60000, 5 * 60000, 15 * 60000, 60 * 60000, 6 * 60 * 60000];
const MAX_ATTEMPTS = 5;
let running = false;
let workerTimer = null;

function buildBackoffDelay(attempts) {
  return BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
}

async function markJob(id, update) {
  try {
    return await PromotionJob.findByIdAndUpdate(id, update, { new: true }).lean();
  } catch (error) {
    console.warn('PromotionWorker: failed to update job', id, error);
    return null;
  }
}

async function processJob(job) {
  if (!job || !job.userId || !job.memoryFingerprint) {
    return null;
  }

  const now = Date.now();
  if (job.status === 'in_progress') {
    return null;
  }

  const nextAttempt = (job.attempts || 0) + 1;
  if (nextAttempt > MAX_ATTEMPTS && job.status === 'failed') {
    return markJob(job._id, { status: 'dead_letter', lastError: 'max promotion attempts exceeded' });
  }

  await markJob(job._id, { status: 'in_progress', attempts: nextAttempt, updatedAt: new Date() });

  try {
    const existing = await LongTermMemory.findOne({ userId: job.userId, fingerprint: job.memoryFingerprint }).lean();
    if (existing) {
      await markJob(job._id, { status: 'done', nextRetryAt: null, lastError: '' });
      return existing;
    }

    const delay = buildBackoffDelay(nextAttempt);
    const status = nextAttempt >= MAX_ATTEMPTS ? 'dead_letter' : 'failed';
    const errorMessage = 'LTM entry missing';
    await markJob(job._id, { status, lastError: errorMessage, nextRetryAt: status === 'failed' ? new Date(now + delay) : null });
    return null;
  } catch (error) {
    const errorMessage = error && error.message ? error.message : String(error);
    const status = nextAttempt >= MAX_ATTEMPTS ? 'dead_letter' : 'failed';
    const delay = buildBackoffDelay(nextAttempt);
    await markJob(job._id, { status, lastError: errorMessage, nextRetryAt: status === 'failed' ? new Date(now + delay) : null });
    console.warn('PromotionWorker: error processing job', job._id, errorMessage);
    return null;
  }
}

async function dequeueEligibleJobs(limit = 10) {
  try {
    const now = new Date();
    return await PromotionJob.find({
      status: { $in: ['queued', 'failed'] },
      $or: [{ nextRetryAt: { $exists: false } }, { nextRetryAt: { $lte: now } }],
    })
      .sort({ status: 1, createdAt: 1 })
      .limit(limit)
      .lean();
  } catch (error) {
    console.warn('PromotionWorker: failed to dequeue jobs', error);
    return [];
  }
}

async function runWorker({ limit = 10 } = {}) {
  const jobs = await dequeueEligibleJobs(limit);
  const results = [];
  for (const job of jobs) {
    const result = await processJob(job);
    results.push({ jobId: String(job._id), result: Boolean(result), status: job.status });
  }
  return results;
}

async function getMetrics() {
  try {
    const total = await PromotionJob.countDocuments();
    const queued = await PromotionJob.countDocuments({ status: 'queued' });
    const inProgress = await PromotionJob.countDocuments({ status: 'in_progress' });
    const failed = await PromotionJob.countDocuments({ status: 'failed' });
    const deadLetter = await PromotionJob.countDocuments({ status: 'dead_letter' });
    const done = await PromotionJob.countDocuments({ status: 'done' });
    return { total, queued, inProgress, failed, deadLetter, done };
  } catch (error) {
    console.warn('PromotionWorker: failed to get metrics', error);
    return { total: 0, queued: 0, inProgress: 0, failed: 0, deadLetter: 0, done: 0 };
  }
}

function start(intervalMs = env.promotionWorkerIntervalMs, limit = env.promotionWorkerLimit) {
  if (running) return;
  running = true;
  runWorker({ limit }).catch((error) => console.warn('PromotionWorker initial run failed', error));
  workerTimer = setInterval(() => {
    runWorker({ limit }).catch((error) => console.warn('PromotionWorker background error', error));
  }, intervalMs);
}

function stop() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  running = false;
}

module.exports = { runWorker, getMetrics, processJob, start, stop };
