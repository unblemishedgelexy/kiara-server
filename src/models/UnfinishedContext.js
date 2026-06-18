const mongoose = require('mongoose');

const unfinishedContextSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    topic: { type: String, required: true },
    question: { type: String, required: true },
    status: { type: String, enum: ['pending', 'resolved'], default: 'pending', index: true },
    priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal', index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.models.UnfinishedContext || mongoose.model('UnfinishedContext', unfinishedContextSchema, 'unfinished_context');