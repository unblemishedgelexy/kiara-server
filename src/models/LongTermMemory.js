const mongoose = require('mongoose');

const memorySchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true
    },

    category: {
      type: String,
      enum: [
        'identity',
        'preference',
        'relationship',
        'project',
        'goal',
        'event',
        'fact'
      ],
      required: true
    },

    content: {
      type: String,
      required: true
    },

    importance: {
      type: Number,
      min: 0,
      max: 1,
      default: 0.5
    },

    accessCount: {
      type: Number,
      default: 0
    },

    memoryStrength: {
      type: Number,
      default: 1
    },

    lastAccessed: {
      type: Date,
      default: Date.now
    },

    emotionalWeight: {
      type: Number,
      min: 0,
      max: 1,
      default: 0
    }
  },
  {
    timestamps: true
  }
);

memorySchema.index({ userId: 1, category: 1 });
memorySchema.index({ userId: 1, importance: -1 });

module.exports = mongoose.model('Memory', memorySchema);