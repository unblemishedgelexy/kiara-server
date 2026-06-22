const ActiveContext = require('../../models/ActiveContext');
const sessionContinuityCacheService = require('./sessionContinuityCacheService');
const { ensureUserId } = require('../../utils/ensureUserId');

async function validateContinuity(userId) {
  ensureUserId(userId);

  const activeContexts = await ActiveContext.find({ userId }).lean();
  const continuityCache = await sessionContinuityCacheService.getContinuityCache(userId);

  const issues = [];

  for (const context of activeContexts) {
    if (!context.currentTopic) {
      issues.push({ type: 'missing_currentTopic', sessionId: context.sessionId });
    }
    if (!context.lastQuestion) {
      issues.push({ type: 'missing_lastQuestion', sessionId: context.sessionId });
    }
    if (!Array.isArray(context.pendingQuestions)) {
      issues.push({ type: 'invalid_pendingQuestions', sessionId: context.sessionId });
    }
    if (!Array.isArray(context.pendingTasks)) {
      issues.push({ type: 'invalid_pendingTasks', sessionId: context.sessionId });
    }
    if (!['neutral', 'happy', 'sad', 'angry', 'confused', 'focused', undefined].includes(context.currentEmotion)) {
      issues.push({ type: 'invalid_emotion', sessionId: context.sessionId, emotion: context.currentEmotion });
    }
    if (!context.currentGoal && !context.currentTopic) {
      issues.push({ type: 'missing_goal_or_topic', sessionId: context.sessionId });
    }
  }

  if (!continuityCache) {
    issues.push({ type: 'missing_continuity_cache' });
  }

  return {
    userId,
    issues,
    sessionCount: activeContexts.length,
    continuityCachePresent: Boolean(continuityCache),
  };
}

async function repairContinuity(userId) {
  ensureUserId(userId);

  const activeContexts = await ActiveContext.find({ userId }).lean();
  const repairs = [];

  for (const context of activeContexts) {
    const updates = {};
    if (!context.pendingQuestions) updates.pendingQuestions = [];
    if (!context.pendingTasks) updates.pendingTasks = [];
    if (!context.currentEmotion) updates.currentEmotion = 'neutral';
    if (!context.currentTopic && context.lastQuestion) updates.currentTopic = 'follow-up';
    if (!context.currentGoal && !context.currentTopic) updates.currentGoal = 'general';

    if (Object.keys(updates).length) {
      await ActiveContext.updateOne({ _id: context._id }, { $set: updates });
      repairs.push({ sessionId: context.sessionId, updated: updates });
    }
  }

  await sessionContinuityCacheService.invalidateContinuityCache(userId);
  await sessionContinuityCacheService.refreshContinuityCache(userId);

  return {
    userId,
    repairs,
    repairedAt: new Date().toISOString(),
  };
}

module.exports = {
  validateContinuity,
  repairContinuity,
};