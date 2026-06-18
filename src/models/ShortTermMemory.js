const mongoose = require('mongoose');

const shortTermMemorySchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true
    },

    content: {
      type: String,
      required: true
    },

    importance: {
      type: Number,
      min: 0,
      max: 1,
      default: 0.3
    },

    accessCount: {
      type: Number,
      default: 0
    },

    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 24 * 60 * 60 * 1000)
    }
  },
  {
    timestamps: true
  }
);

// automatic forgetting
shortTermMemorySchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 }
);

module.exports = mongoose.model(
  'ShortTermMemory',
  shortTermMemorySchema
);