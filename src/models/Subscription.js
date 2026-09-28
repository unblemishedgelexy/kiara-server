const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    planId: { type: String, enum: ['starter', 'pro', 'premium'], required: true },
    status: {
      type: String,
      enum: ['created', 'authenticated', 'active', 'pending', 'halted', 'paused', 'cancelled', 'completed', 'expired', 'failed'],
      default: 'created',
      index: true,
    },
    amountPaise: { type: Number, required: true },
    currency: { type: String, default: 'INR', required: true },
    razorpayCustomerId: { type: String, default: null },
    razorpaySubscriptionId: { type: String, required: true, unique: true },
    razorpayPlanId: { type: String, required: true },
    razorpayOrderId: { type: String, default: null },
    paymentId: { type: String, default: null },
    pendingPlanId: { type: String, enum: ['starter', 'pro', 'premium', null], default: null },
    pendingPlanChangeAt: { type: Date, default: null },
    checkoutExpiresAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    renewalDate: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    cancelAtCycleEnd: { type: Boolean, default: false },
    lastWebhookEvent: { type: String, default: null },
  },
  { timestamps: true },
);

subscriptionSchema.index({ userId: 1, status: 1, expiresAt: -1 });

module.exports = mongoose.models.Subscription || mongoose.model('Subscription', subscriptionSchema);