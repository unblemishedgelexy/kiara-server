const mongoose = require('mongoose');

const OAuthStateSchema = new mongoose.Schema(
  {
    state: { type: String, required: true, unique: true },
    codeVerifier: { type: String, required: true },
    returnUrl: { type: String, required: true },
    purpose: { type: String, enum: ['user'], default: 'user' },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

OAuthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.OAuthState || mongoose.model('OAuthState', OAuthStateSchema);
