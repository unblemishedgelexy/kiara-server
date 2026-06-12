const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    // User identity
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    displayName: { type: String, trim: true },
    
    // Email and authentication
    email: { type: String, lowercase: true, sparse: true, trim: true, unique: true, required: true },
    passwordHash: { type: String, required: true },
    
    // Email verification
    emailVerified: { type: Boolean, default: false },
    
    // Legacy OAuth fields (optional for Google Sign-In)
    googleId: { type: String, trim: true, sparse: true, unique: true },
    googleEmail: { type: String, lowercase: true, trim: true },
    
    // Mobile (optional)
    mobileNumber: { type: String, trim: true, sparse: true, unique: true },
    mobileVerified: { type: Boolean, default: false },
    
    // Profile
    profilePicture: { type: String },
    
    // Role and status
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    mode: { type: String, enum: ['registered', 'guest'], default: 'registered' },
    isActive: { type: Boolean, default: true },
    
    // Token management
    refreshTokenHash: { type: String },
    
    // Security and rate limiting
    lastLogin: { type: Date },
    failedLoginAttempts: { type: Number, default: 0 },
    loginLockedUntil: { type: Date },
    failedOtpAttempts: { type: Number, default: 0 },
    otpLockedUntil: { type: Date },
    
    // Two-factor authentication (future feature)
    twoFactorEnabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Indexes for performance and uniqueness
userSchema.index({ createdAt: -1 });
userSchema.index({ emailVerified: 1 });

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
