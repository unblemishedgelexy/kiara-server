const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    displayName: { type: String, trim: true },
    email: { type: String, lowercase: true, sparse: true, trim: true, unique: true, required: true },
    emailVerified: { type: Boolean, default: false }, // Must verify via OTP
    mobileNumber: { type: String, trim: true, sparse: true, unique: true },
    mobileVerified: { type: Boolean, default: false },
    passwordHash: { type: String, required: true }, // Required for email/password auth
    profilePicture: { type: String },
    googleId: { type: String, trim: true, sparse: true, unique: true }, // Optional for Google OAuth
    googleEmail: { type: String, lowercase: true, trim: true },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    mode: { type: String, enum: ['registered', 'guest'], default: 'registered' },
    refreshTokenHash: { type: String },
    // Security fields
    lastLogin: { type: Date },
    failedOtpAttempts: { type: Number, default: 0 },
    accountLockedUntil: { type: Date },
    failedLoginAttempts: { type: Number, default: 0 },
    loginLockedUntil: { type: Date },
    isActive: { type: Boolean, default: true },
    twoFactorEnabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Index for efficient queries
userSchema.index({ createdAt: -1 });

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
