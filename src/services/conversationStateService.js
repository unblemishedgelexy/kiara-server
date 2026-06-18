const ConversationState = require('../models/ConversationState');

async function getConversationState(userId) {
  if (!userId) return null;
  const state = await ConversationState.findOne({ userId }).sort({ updatedAt: -1 }).lean();
  if (!state) {
    return {
      userId,
      currentTopic: '',
      lastQuestion: '',
      lastUserMessage: '',
      lastAssistantMessage: '',
      currentTask: '',
      emotion: '',
      pendingQuestions: [],
      pendingTasks: [],
      lastSessionId: '',
      sessionSummary: '',
      updatedAt: new Date(),
    };
  }
  return state;
}

async function updateConversationState(userId, updates = {}) {
  if (!userId) {
    throw new Error('userId is required to update conversation state');
  }

  const existing = await ConversationState.findOne({ userId }).sort({ updatedAt: -1 });
  if (existing) {
    Object.assign(existing, updates, { updatedAt: new Date() });
    await existing.save();
    return existing.toObject();
  }

  const created = await ConversationState.create({ userId, ...updates, updatedAt: new Date() });
  return created.toObject();
}

module.exports = { getConversationState, updateConversationState };