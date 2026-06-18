const mongoose = require('mongoose');

const memoryJobSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    message: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending',
      index: true,
    },
    priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal', index: true },
    attempts: { type: Number, default: 0 },
    error: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.models.MemoryJob || mongoose.model('MemoryJob', memoryJobSchema, 'memory_jobs');