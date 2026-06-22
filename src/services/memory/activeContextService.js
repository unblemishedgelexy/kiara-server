const ActiveContext = require('../../models/ActiveContext');
const { ensureUserId } = require('../../utils/ensureUserId');

async function initializeContext(userId, sessionId) {
  ensureUserId(userId);
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId is required');
  }

  const context = await ActiveContext.findOneAndUpdate(
    { userId, sessionId },
    {
      userId,
      sessionId,
      currentTopic: null,
      currentGoal: null,
      currentTask: null,
      currentEmotion: 'neutral',
      pendingQuestions: [],
      pendingTasks: [],
      updatedAt: new Date(),
    },
    { upsert: true, new: true }
  );

  return context;
}

async function updateContext(userId, sessionId, updates = {}) {
  ensureUserId(userId);
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId is required');
  }

  const allowedFields = ['currentTopic', 'currentGoal', 'currentTask', 'lastQuestion', 'currentEmotion', 'activeParticipants'];
  const updateObj = { updatedAt: new Date() };

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      updateObj[field] = updates[field];
    }
  }

  const context = await ActiveContext.findOneAndUpdate({ userId, sessionId }, updateObj, { new: true });
  return context;
}

async function getContext(userId, sessionId) {
  ensureUserId(userId);
  const context = await ActiveContext.findOne({ userId, sessionId }).lean();
  return context || null;
}

async function addPendingQuestion(userId, sessionId, question) {
  ensureUserId(userId);
  if (!question || typeof question !== 'string') {
    throw new Error('Question is required');
  }

  await ActiveContext.findOneAndUpdate(
    { userId, sessionId },
    {
      $addToSet: { pendingQuestions: question },
      $set: { updatedAt: new Date() },
    },
    { upsert: true }
  );
}

async function removePendingQuestion(userId, sessionId, question) {
  ensureUserId(userId);
  await ActiveContext.findOneAndUpdate(
    { userId, sessionId },
    {
      $pull: { pendingQuestions: question },
      $set: { updatedAt: new Date() },
    }
  );
}

async function addPendingTask(userId, sessionId, task) {
  ensureUserId(userId);
  if (!task || typeof task !== 'string') {
    throw new Error('Task is required');
  }

  await ActiveContext.findOneAndUpdate(
    { userId, sessionId },
    {
      $addToSet: { pendingTasks: task },
      $set: { updatedAt: new Date() },
    },
    { upsert: true }
  );
}

async function removePendingTask(userId, sessionId, task) {
  ensureUserId(userId);
  await ActiveContext.findOneAndUpdate(
    { userId, sessionId },
    {
      $pull: { pendingTasks: task },
      $set: { updatedAt: new Date() },
    }
  );
}

async function setLastQuestion(userId, sessionId, question) {
  ensureUserId(userId);
  await ActiveContext.findOneAndUpdate(
    { userId, sessionId },
    {
      $set: { lastQuestion: question, updatedAt: new Date() },
    },
    { upsert: true }
  );
}

async function clearContext(userId, sessionId) {
  ensureUserId(userId);
  await ActiveContext.deleteOne({ userId, sessionId });
}

module.exports = {
  initializeContext,
  updateContext,
  getContext,
  addPendingQuestion,
  removePendingQuestion,
  addPendingTask,
  removePendingTask,
  setLastQuestion,
  clearContext,
};
