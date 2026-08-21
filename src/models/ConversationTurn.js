'use strict';

const mongoose = require('mongoose');

const ConversationTurnSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  sessionId: { type: String, required: true, index: true },
  userMessage: { type: String, required: true },
  assistantResponse: { type: String, required: true },
  timestamp: { type: Date, default: Date.now, index: true },
  raw: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
}, {
  timestamps: true,
});

module.exports = mongoose.models.ConversationTurn || mongoose.model('ConversationTurn', ConversationTurnSchema);
