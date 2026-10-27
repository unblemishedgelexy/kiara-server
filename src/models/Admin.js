const mongoose = require('mongoose');

const adminSchema = new mongoose.Schema(
  {
    firstName: { type: String, trim: true, required: true },
    lastName: { type: String, trim: true, required: true },
    displayName: { type: String, trim: true },
    email: { type: String, lowercase: true, trim: true, unique: true, required: true },
    passwordHash: { type: String, required: true, select: false },
    emailVerified: { type: Boolean, default: true },
    role: { type: String, enum: ['dev', 'admin'], default: 'admin' },
    isActive: { type: Boolean, default: true },
    isInitialAdmin: { type: Boolean, select: false },
    lastLogin: { type: Date },
    failedLoginAttempts: { type: Number, default: 0 },
    loginLockedUntil: { type: Date },
  },
  { timestamps: true },
);

adminSchema.index(
  { isInitialAdmin: 1 },
  {
    unique: true,
    partialFilterExpression: { isInitialAdmin: true },
    name: 'unique_initial_admin',
  },
);

module.exports = mongoose.models.Admin || mongoose.model('Admin', adminSchema);
