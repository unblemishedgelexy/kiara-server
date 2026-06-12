const mongoose = require('mongoose');

const OTPSchema = new mongoose.Schema({
  identifier: { type: String, index: true }, // email or phone
  codeHash: { type: String }, // Hashed OTP code (bcrypt) - store hash for security
  type: { 
    type: String, 
    enum: ['REGISTER_EMAIL', 'REGISTER_MOBILE', 'FORGOT_PASSWORD_EMAIL', 'FORGOT_PASSWORD_MOBILE', 'EMAIL_VERIFICATION_OTP', 'CHANGE_EMAIL', 'CHANGE_MOBILE'],
    default: 'REGISTER_EMAIL' 
  },
  used: { type: Boolean, default: false },
  usedAt: { type: Date, default: null },
  expiresAt: { type: Date, index: { expires: 0 } }, // Auto-delete expired OTPs
  
  // Security fields
  failedAttempts: { type: Number, default: 0 }, // Track failed verification attempts
  maxAttempts: { type: Number, default: 5 }, // Max failed attempts before lockout
  lockedUntil: { type: Date, default: null }, // OTP locked after too many failed attempts
  ipAddress: { type: String }, // IP of request that created OTP
  userAgent: { type: String }, // User agent for device tracking
  
  // Metadata
  meta: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

// Index for efficient queries
OTPSchema.index({ identifier: 1, type: 1, expiresAt: 1 });
OTPSchema.index({ identifier: 1, used: 1 });

module.exports = mongoose.model('OTP', OTPSchema);
