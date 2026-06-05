const mongoose = require('mongoose');

const summarySchema = new mongoose.Schema(
  {
    chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true, index: true },
    content: { type: String, required: true, trim: true },
    upToMessageCreatedAt: { type: Date, required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Summary || mongoose.model('Summary', summarySchema);
