const mongoose = require('mongoose');

const pendingReservationSchema = new mongoose.Schema({
  id: { type: String, required: true },
  expiresAt: { type: Date, required: true },
}, { _id: false });

const activeLiveSessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true },
  startedAt: { type: Date, required: true },
  lastHeartbeatAt: { type: Date, required: true },
}, { _id: false });

const usageSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    liveSeconds: { type: Number, default: 0, min: 0 },
    chatMessages: { type: Number, default: 0, min: 0 },
    pendingChatReservations: { type: [pendingReservationSchema], default: [] },
    activeLiveSessions: { type: [activeLiveSessionSchema], default: [] },
    activeLiveSessionId: { type: String, default: null },
    lastLiveHeartbeatAt: { type: Date, default: null },
  },
  { timestamps: true },
);

usageSchema.index({ userId: 1, periodStart: 1 }, { unique: true });

module.exports = mongoose.models.SubscriptionUsage || mongoose.model('SubscriptionUsage', usageSchema);