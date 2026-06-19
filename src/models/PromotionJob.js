const mongoose = require('mongoose');

const promotionJobSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    sessionId: { type: String, default: 'default' },
    memoryFingerprint: { type: String, required: true, index: true },
    memoryCategory: { type: String, default: 'other' },
    memoryId: { type: String },
    status: { type: String, enum: ['queued', 'in_progress', 'failed', 'done', 'dead_letter'], default: 'queued', index: true },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: '' },
    nextRetryAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.PromotionJob || mongoose.model('PromotionJob', promotionJobSchema, 'promotion_jobs');
