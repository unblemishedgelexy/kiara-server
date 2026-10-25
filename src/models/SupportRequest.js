const mongoose = require('mongoose');

const supportRequestSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    subject: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 3000 },
    rating: { type: Number, min: 1, max: 5 },
    status: { type: String, enum: ['open', 'in_progress', 'resolved'], default: 'open' },
  },
  { timestamps: true },
);

module.exports = mongoose.models.SupportRequest || mongoose.model('SupportRequest', supportRequestSchema);
