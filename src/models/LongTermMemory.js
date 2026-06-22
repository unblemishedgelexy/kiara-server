const mongoose = require('mongoose');

const memorySchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },

    category: {
      type: String,
      enum: [
        'identity',
        'preference',
        'preferences',
        'relationship',
        'relationships',
        'project',
        'projects',
        'goal',
        'goals',
        'event',
        'events',
        'fact',
        'facts',
        'other',
      ],
      required: true,
    },

    encryptedMemory: {
      type: String,
      required: true,
    },

    tags: {
      type: [String],
      default: [],
    },

    importanceScore: {
      type: Number,
      min: 0,
      max: 1,
      default: 0.5,
    },

    accessCount: {
      type: Number,
      default: 0,
    },

    memoryStrength: {
      type: Number,
      default: 1,
    },

    lastAccessed: {
      type: Date,
      default: Date.now,
    },

    emotionalWeight: {
      type: Number,
      min: 0,
      max: 1,
      default: 0,
    },
    confidence: { type: Number, min: 0, max: 1, default: 0.5 },
    fingerprint: { type: String, index: true },
    active: { type: Boolean, default: true, index: true },
    obsolete: { type: Boolean, default: false, index: true },
    supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Memory' },
  },
  {
    timestamps: true,
  }
);

memorySchema.index({ userId: 1, category: 1 });
memorySchema.index({ userId: 1, importanceScore: -1 });

module.exports = mongoose.model('Memory', memorySchema);