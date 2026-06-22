const FollowUpMemory = require('../../models/FollowUpMemory');
const { ensureUserId } = require('../../utils/ensureUserId');

async function createFollowUp(userId, topic, options = {}) {
  ensureUserId(userId);
  if (!topic || typeof topic !== 'string') {
    throw new Error('Topic is required');
  }

  const followUp = await FollowUpMemory.create({
    userId,
    topic,
    topicLower: topic.toLowerCase(),
    followUpDate: options.followUpDate,
    dueDate: options.dueDate,
    status: options.status || 'pending',
    priority: options.priority || 'medium',
    relatedPeople: options.relatedPeople || [],
    relatedProjects: options.relatedProjects || [],
    description: options.description,
    suggestedQuestion: options.suggestedQuestion,
  });

  return followUp;
}

async function getPendingFollowUps(userId) {
  ensureUserId(userId);
  return FollowUpMemory.find({ userId, status: 'pending' }).sort({ priority: -1, dueDate: 1 }).lean();
}

async function getFollowUpsByPerson(userId, personName) {
  ensureUserId(userId);
  if (!personName || typeof personName !== 'string') {
    return [];
  }

  return FollowUpMemory.find({
    userId,
    relatedPeople: { $regex: personName, $options: 'i' },
    status: 'pending',
  }).lean();
}

async function getFollowUpsByProject(userId, projectName) {
  ensureUserId(userId);
  if (!projectName || typeof projectName !== 'string') {
    return [];
  }

  return FollowUpMemory.find({
    userId,
    relatedProjects: { $regex: projectName, $options: 'i' },
    status: 'pending',
  }).lean();
}

async function completeFollowUp(userId, followUpId) {
  ensureUserId(userId);
  return FollowUpMemory.findByIdAndUpdate(
    followUpId,
    {
      status: 'completed',
      completedAt: new Date(),
    },
    { new: true }
  );
}

async function markFollowUpInProgress(userId, followUpId) {
  ensureUserId(userId);
  return FollowUpMemory.findByIdAndUpdate(
    followUpId,
    { status: 'in_progress' },
    { new: true }
  );
}

async function cancelFollowUp(userId, followUpId) {
  ensureUserId(userId);
  return FollowUpMemory.findByIdAndUpdate(
    followUpId,
    { status: 'cancelled' },
    { new: true }
  );
}

async function getOverdueFollowUps(userId) {
  ensureUserId(userId);
  const now = new Date();
  return FollowUpMemory.find({
    userId,
    status: { $in: ['pending', 'in_progress'] },
    dueDate: { $lt: now },
  })
    .sort({ dueDate: 1 })
    .lean();
}

async function getUpcomingFollowUps(userId, daysAhead = 7) {
  ensureUserId(userId);
  const now = new Date();
  const futureDate = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  return FollowUpMemory.find({
    userId,
    status: 'pending',
    dueDate: { $gte: now, $lte: futureDate },
  })
    .sort({ dueDate: 1 })
    .lean();
}

module.exports = {
  createFollowUp,
  getPendingFollowUps,
  getFollowUpsByPerson,
  getFollowUpsByProject,
  completeFollowUp,
  markFollowUpInProgress,
  cancelFollowUp,
  getOverdueFollowUps,
  getUpcomingFollowUps,
};
