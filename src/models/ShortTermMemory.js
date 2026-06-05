const mongoose = require('mongoose');

const ShortTermMemorySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sessionId: { type: String, required: true, index: true },
  role: { type: String },
  message: { type: String },
  timestamp: { type: Date, default: Date.now },
  expiresAt: { type: Date, index: { expires: 0 } }
});

module.exports = mongoose.model('ShortTermMemory', ShortTermMemorySchema);
