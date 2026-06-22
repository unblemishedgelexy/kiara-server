const MemoryJob = require('../../models/MemoryJob');

async function enqueueMemoryJob({ userId, message, priority = 'normal' }) {
  return MemoryJob.create({ userId, message, priority, status: 'pending', attempts: 0 });
}

async function fetchPendingJob() {
  const job = await MemoryJob.findOneAndUpdate(
    { status: 'pending' },
    { $set: { status: 'processing', processingStartedAt: new Date(), updatedAt: new Date(), lastStep: 'dequeued' }, $unset: { stackTrace: '' } },
    { sort: { priority: -1, createdAt: 1 }, new: true }
  ).lean();
  return job;
}

async function markJobCompleted(jobId) {
  return MemoryJob.findByIdAndUpdate(jobId, { status: 'completed', updatedAt: new Date() }, { new: true }).lean();
}

async function markJobFailed(jobId, errorMessage) {
  return MemoryJob.findByIdAndUpdate(
    jobId,
    { $set: { status: 'failed', error: errorMessage, updatedAt: new Date() }, $inc: { attempts: 1 } },
    { new: true }
  )
    .lean()
    .catch(() => null);
}

async function markJobFailedWithStack(jobId, error) {
  const errorMessage = error && error.message ? error.message : String(error || 'error');
  const stack = error && error.stack ? error.stack : '';
  return MemoryJob.findByIdAndUpdate(
    jobId,
    { $set: { status: 'failed', error: errorMessage, stackTrace: stack, updatedAt: new Date() }, $inc: { attempts: 1 } },
    { new: true }
  )
    .lean()
    .catch(() => null);
}

async function findProcessingJobsDetailed(limit = 100) {
  return MemoryJob.find({ status: 'processing' }).sort({ processingStartedAt: 1 }).limit(limit).lean();
}

async function resetStaleProcessingJobs(staleThresholdMs = 10 * 60 * 1000) {
  const cutoff = new Date(Date.now() - staleThresholdMs);
  const staleJobs = await MemoryJob.find({ status: 'processing', processingStartedAt: { $lt: cutoff } }).lean();
  if (!staleJobs || !staleJobs.length) return { resetCount: 0, jobs: [] };
  const updates = staleJobs.map((job) =>
    MemoryJob.findByIdAndUpdate(
      job._id,
      { $set: { status: 'pending', updatedAt: new Date(), lastStep: 'stale-reset' }, $unset: { processingStartedAt: '' } },
      { new: true }
    )
  );
  await Promise.all(updates);
  return { resetCount: staleJobs.length, jobs: staleJobs };
}

async function retryFailedJobs(maxAttempts = 3) {
  const jobs = await MemoryJob.find({ status: 'failed', attempts: { $lt: maxAttempts } }).lean();
  const updates = jobs.map((job) =>
    MemoryJob.findByIdAndUpdate(job._id, { status: 'pending', updatedAt: new Date() }, { new: true })
  );
  return Promise.all(updates);
}

async function cleanupOldJobs(days = 30) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await MemoryJob.deleteMany({ updatedAt: { $lt: cutoff } });
  return result.deletedCount;
}

async function countQueueStatus() {
  const [pending, processing, completed, failed] = await Promise.all([
    MemoryJob.countDocuments({ status: 'pending' }),
    MemoryJob.countDocuments({ status: 'processing' }),
    MemoryJob.countDocuments({ status: 'completed' }),
    MemoryJob.countDocuments({ status: 'failed' }),
  ]);
  return { pending, processing, completed, failed };
}

async function countQueueStatusWithStale(staleThresholdMs = 10 * 60 * 1000) {
  const [pending, processing, completed, failed] = await Promise.all([
    MemoryJob.countDocuments({ status: 'pending' }),
    MemoryJob.countDocuments({ status: 'processing' }),
    MemoryJob.countDocuments({ status: 'completed' }),
    MemoryJob.countDocuments({ status: 'failed' }),
  ]);
  const cutoff = new Date(Date.now() - staleThresholdMs);
  const staleProcessing = await MemoryJob.countDocuments({ status: 'processing', processingStartedAt: { $lt: cutoff } });
  return { pending, processing, completed, failed, staleProcessing };
}

module.exports = {
  enqueueMemoryJob,
  fetchPendingJob,
  markJobCompleted,
  markJobFailed,
  markJobFailedWithStack,
  retryFailedJobs,
  cleanupOldJobs,
  countQueueStatus,
  countQueueStatusWithStale,
  findProcessingJobsDetailed,
  resetStaleProcessingJobs,
};