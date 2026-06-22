const mongoose = require('mongoose');

const activeContextSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    currentTopic: String,
    currentGoal: String,
    currentTask: String,
    lastQuestion: String,
    pendingQuestions: [String],
    pendingTasks: [String],
    currentEmotion: { type: String, enum: ['happy', 'sad', 'curious', 'focused', 'confused', 'neutral'], default: 'neutral' },
    contextSummary: String,
    activeParticipants: [String],
    recentMemories: [mongoose.Schema.Types.ObjectId],
    createdAt: { type: Date, default: Date.now, expire: 86400 },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

activeContextSchema.index({ userId: 1, sessionId: 1 });

module.exports = mongoose.model('ActiveContext', activeContextSchema);
