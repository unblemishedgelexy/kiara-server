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
    
    // Email verification - NEW FIELDS FOR REDESIGNED FLOW
    isVerified: { type: Boolean, default: false }, // Account verification status
    verifiedAt: { type: Date, default: null }, // Timestamp when account was verified
    verificationMethod: { 
      type: String, 
      enum: ['registration_otp', 'password_reset_otp', 'oauth', 'admin'],
      default: null 
    }, // How the account was verified
    
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
userSchema.index({ email: 1 });
userSchema.index({ isVerified: 1 });
userSchema.index({ verifiedAt: 1 });

// Pre-save hook to update verifiedAt timestamp
userSchema.pre('save', function(next) {
  // If isVerified changes from false to true and verifiedAt is not set, set it now
  if (this.isModified('isVerified') && this.isVerified && !this.verifiedAt) {
    this.verifiedAt = new Date();
  }
  next();
});

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
