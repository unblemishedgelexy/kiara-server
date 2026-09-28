const mongoose = require('mongoose');

const razorpayPaymentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  subscriptionId: { type: String, required: true, index: true },
  paymentId: { type: String, required: true, unique: true },
  amountPaise: { type: Number, required: true },
  currency: { type: String, required: true },
  status: { type: String, enum: ['captured', 'failed', 'authorized'], required: true },
  paidAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.models.RazorpayPayment || mongoose.model('RazorpayPayment', razorpayPaymentSchema);