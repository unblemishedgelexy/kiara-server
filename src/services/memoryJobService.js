const MemoryJob = require('../models/MemoryJob');

async function enqueueMemoryJob({ userId, message, priority = 'normal' }) {
  return MemoryJob.create({ userId, message, priority, status: 'pending', attempts: 0 });
}

async function fetchPendingJob() {
  const job = await MemoryJob.findOneAndUpdate(
    { status: 'pending' },
    { status: 'processing', updatedAt: new Date() },
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
  ).lean();
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

module.exports = {
  enqueueMemoryJob,
  fetchPendingJob,
  markJobCompleted,
  markJobFailed,
  retryFailedJobs,
  cleanupOldJobs,
  countQueueStatus,
};