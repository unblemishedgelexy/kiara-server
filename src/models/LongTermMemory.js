const mongoose = require('mongoose');

const LongTermMemorySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  category: { type: String },
  encryptedMemory: { type: String, required: true },
  tags: [{ type: String }],
  importanceScore: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('LongTermMemory', LongTermMemorySchema);
