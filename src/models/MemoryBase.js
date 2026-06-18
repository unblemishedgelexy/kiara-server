const mongoose = require('mongoose');

function createMemorySchema() {
  return new mongoose.Schema(
    {
      userId: { type: String, required: true, index: true },
      category: {
        type: String,
        required: true,
        enum: ['identity', 'preference', 'relationship', 'project', 'goal', 'fact', 'event', 'episodic'],
      },
      encryptedMemory: { type: String, required: true },
      tags: { type: [String], default: [] },
      importanceScore: { type: Number, min: 0, max: 1, default: 0.5 },
      accessCount: { type: Number, default: 0 },
      memoryStrength: { type: Number, default: 1 },
      lastAccessed: { type: Date, default: Date.now },
      emotionalWeight: { type: Number, min: 0, max: 1, default: 0 },
      source: { type: String, default: 'pipeline' },
      confidence: { type: Number, min: 0, max: 1, default: 0.5, index: true },
    },
    { timestamps: true }
  );
}

module.exports = { createMemorySchema };