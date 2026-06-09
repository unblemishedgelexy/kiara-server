const mongoose = require('mongoose');

const pendingRegistrationSchema = new mongoose.Schema(
  {
    firstName: { type: String, trim: true, required: true },
    lastName: { type: String, trim: true, required: true },
    email: { type: String, lowercase: true, trim: true, required: true },
    mobileNumber: { type: String, trim: true, required: true },
    passwordHash: { type: String, required: true },
    emailVerified: { type: Boolean, default: false },
    mobileVerified: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

module.exports = mongoose.models.PendingRegistration || mongoose.model('PendingRegistration', pendingRegistrationSchema);
