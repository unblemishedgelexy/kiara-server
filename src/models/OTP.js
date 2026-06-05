const mongoose = require('mongoose');

const OTPSchema = new mongoose.Schema({
  identifier: { type: String }, // email or phone
  code: { type: String },
  type: { type: String, enum: ['register', 'password', 'sms', 'email'], default: 'register' },
  used: { type: Boolean, default: false },
  expiresAt: { type: Date, index: { expires: 0 } },
  meta: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

module.exports = mongoose.model('OTP', OTPSchema);
