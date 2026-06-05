const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    displayName: { type: String, trim: true },
    email: { type: String, lowercase: true, sparse: true, trim: true, unique: true },
    emailVerified: { type: Boolean, default: false },
    mobileNumber: { type: String, trim: true, sparse: true, unique: true },
    mobileVerified: { type: Boolean, default: false },
    passwordHash: { type: String },
    profilePicture: { type: String },
    googleId: { type: String, trim: true, sparse: true, unique: true },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    mode: { type: String, enum: ['guest', 'registered'], default: 'registered' },
    refreshTokenHash: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
