const mongoose = require('mongoose');

const memoryProfileSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    identitySummary: { type: String, default: '' },
    preferenceSummary: { type: String, default: '' },
    relationshipSummary: { type: String, default: '' },
    projectSummary: { type: String, default: '' },
    goalSummary: { type: String, default: '' },
    lastTopic: { type: String, default: '' },
    lastQuestion: { type: String, default: '' },
    pendingTasks: { type: [String], default: [] },
    pendingQuestions: { type: [String], default: [] },
    compressedProfile: { type: String, default: '' },
    profileTokenCount: { type: Number, default: 0 },
    bootstrapContext: { type: String, default: '' },
    bootstrapVersion: { type: Number, default: 1 },
    lastUpdated: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.models.MemoryProfile || mongoose.model('MemoryProfile', memoryProfileSchema, 'memory_profile');