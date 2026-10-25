const mongoose = require('mongoose');

const accountDeletionRequestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  tokenHash: { type: String, unique: true, sparse: true },
  tokenExpiresAt: { type: Date },
  status: {
    type: String,
    enum: ['confirmation_pending', 'scheduled', 'processing', 'cancelled', 'completed'],
    default: 'confirmation_pending',
    index: true,
  },
  requestedAt: { type: Date, default: Date.now },
  confirmedAt: { type: Date, default: null },
  deleteAt: { type: Date, default: null },
  processingStartedAt: { type: Date, default: null },
  attempts: { type: Number, default: 0 },
  lastErrorCode: { type: String, default: null },
}, { timestamps: true });

accountDeletionRequestSchema.index({ status: 1, deleteAt: 1 });
accountDeletionRequestSchema.index({ userId: 1, status: 1, requestedAt: -1 });

module.exports = mongoose.models.AccountDeletionRequest
  || mongoose.model('AccountDeletionRequest', accountDeletionRequestSchema);
