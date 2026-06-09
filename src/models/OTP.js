const mongoose = require('mongoose');

const OTPSchema = new mongoose.Schema({
  identifier: { type: String }, // email or phone
  code: { type: String },
  type: { type: String, enum: ['REGISTER_EMAIL', 'REGISTER_MOBILE', 'FORGOT_PASSWORD_EMAIL', 'FORGOT_PASSWORD_MOBILE', 'CHANGE_EMAIL', 'CHANGE_MOBILE'], default: 'REGISTER_EMAIL' },
  used: { type: Boolean, default: false },
  expiresAt: { type: Date, index: { expires: 0 } },
  meta: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

module.exports = mongoose.model('OTP', OTPSchema);
