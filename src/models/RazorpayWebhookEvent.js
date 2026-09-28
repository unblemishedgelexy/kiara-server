const mongoose = require('mongoose');

const razorpayWebhookEventSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  eventId: { type: String, required: true, unique: true },
  event: { type: String, required: true },
  processedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.models.RazorpayWebhookEvent || mongoose.model('RazorpayWebhookEvent', razorpayWebhookEventSchema);