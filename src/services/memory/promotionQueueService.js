const PromotionJob = require('../../models/PromotionJob');

async function enqueuePromotion({ userId, sessionId = 'default', memoryFingerprint, memoryCategory, memoryId }) {
  if (!userId || !memoryFingerprint) throw new Error('userId and memoryFingerprint required');
  const existing = await PromotionJob.findOne({
    userId,
    memoryFingerprint,
    status: { $in: ['queued', 'in_progress', 'failed'] },
  }).lean();
  if (existing) return existing;

  const job = await PromotionJob.create({ userId, sessionId, memoryFingerprint, memoryCategory, memoryId, status: 'queued' });
  return job.toObject ? job.toObject() : job;
}

async function getNextQueued(limit = 10) {
  return PromotionJob.find({ status: 'queued' }).sort({ createdAt: 1 }).limit(limit).lean();
}

async function markInProgress(id) {
  return PromotionJob.findByIdAndUpdate(id, { status: 'in_progress', attempts: (await PromotionJob.findById(id)).attempts + 1 }, { new: true }).lean();
}

async function markDone(id) {
  return PromotionJob.findByIdAndUpdate(id, { status: 'done' }, { new: true }).lean();
}

async function markFailed(id, error) {
  return PromotionJob.findByIdAndUpdate(id, { status: 'failed', lastError: String(error || '').slice(0, 1024) }, { new: true }).lean();
}

async function queueStats() {
  const total = await PromotionJob.countDocuments();
  const queued = await PromotionJob.countDocuments({ status: 'queued' });
  const inProgress = await PromotionJob.countDocuments({ status: 'in_progress' });
  const failed = await PromotionJob.countDocuments({ status: 'failed' });
  const done = await PromotionJob.countDocuments({ status: 'done' });
  const deadLetter = await PromotionJob.countDocuments({ status: 'dead_letter' });
  return { total, queued, inProgress, failed, done, deadLetter };
}

module.exports = { enqueuePromotion, getNextQueued, markInProgress, markDone, markFailed, queueStats };
