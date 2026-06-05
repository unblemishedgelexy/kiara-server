const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema(
  {
    lastMessageAt: { type: Date, default: () => new Date() },
    title: { type: String, trim: true, default: 'Realtime Session' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Chat || mongoose.model('Chat', chatSchema);
