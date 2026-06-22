const mongoose = require('mongoose');

const followUpMemorySchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    topic: { type: String, required: true },
    topicLower: { type: String, required: true },
    followUpDate: Date,
    dueDate: Date,
    status: { type: String, enum: ['pending', 'in_progress', 'completed', 'cancelled'], default: 'pending', index: true },
    priority: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
    relatedPeople: [String],
    relatedProjects: [String],
    description: String,
    suggestedQuestion: String,
    reminderSent: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    completedAt: Date,
  },
  { timestamps: true }
);

followUpMemorySchema.index({ userId: 1, status: 1 });
followUpMemorySchema.index({ userId: 1, dueDate: 1 });
followUpMemorySchema.index({ userId: 1, priority: -1 });

module.exports = mongoose.model('FollowUpMemory', followUpMemorySchema);
