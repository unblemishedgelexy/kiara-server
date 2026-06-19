const UnfinishedContext = require('../../models/UnfinishedContext');

async function createUnfinishedContext({ userId, topic, question, priority = 'normal' }) {
  return UnfinishedContext.create({ userId, topic, question, priority, status: 'pending' });
}

async function resolveUnfinishedContext(id) {
  return UnfinishedContext.findByIdAndUpdate(
    id,
    { status: 'resolved', updatedAt: new Date() },
    { new: true }
  ).lean();
}

async function getPendingContexts(userId, opts = {}) {
  return UnfinishedContext.find({ userId, status: 'pending' }).sort({ priority: -1, updatedAt: 1 }).limit(opts.limit || 50).lean().catch(() => []);
}

async function countPendingContexts() {
  return UnfinishedContext.countDocuments({ status: 'pending' }).catch(() => 0);
}

async function syncUnfinishedContexts(userId, message, extractedMemories = []) {
  // message: latest user message (string). extractedMemories: array of { category, memory }
  if (!userId || !message) return [];
  const questionMatch = message.match(/(.+\?)$/s);
  const topic = extractedMemories.find((memory) => ['project', 'goal', 'relationship'].includes(memory.category))?.memory || 'General';
  const question = questionMatch ? questionMatch[1].trim() : null;

  if (question) {
    const existing = await UnfinishedContext.findOne({ userId, question, status: 'pending' }).lean();
    if (!existing) {
      const created = await createUnfinishedContext({ userId, topic, question, priority: 'normal' });
      return [created];
    }
  }
  return [];
}

module.exports = {
  createUnfinishedContext,
  resolveUnfinishedContext,
  getPendingContexts,
  syncUnfinishedContexts,
  countPendingContexts,
};