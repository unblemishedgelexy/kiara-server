const mongoose = require('mongoose');

const conversationStateSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    currentTopic: { type: String, default: '' },
    lastQuestion: { type: String, default: '' },
    lastUserMessage: { type: String, default: '' },
    lastAssistantMessage: { type: String, default: '' },
    currentTask: { type: String, default: '' },
    emotion: { type: String, default: '' },
    pendingQuestions: { type: [String], default: [] },
    pendingTasks: { type: [String], default: [] },
    previousTopics: { type: [String], default: [] },
    lastSessionId: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ConversationState', conversationStateSchema);
