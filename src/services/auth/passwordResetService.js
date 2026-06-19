const crypto = require('crypto');
const PasswordResetToken = require('../../models/PasswordResetToken');
const { hashToken } = require('./tokenService');

async function createPasswordResetToken(userId, expiresInSeconds = 600) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  await PasswordResetToken.create({ userId, tokenHash, expiresAt });
  return rawToken;
}

async function verifyPasswordResetToken(rawToken) {
  const tokenHash = hashToken(rawToken);
  const token = await PasswordResetToken.findOne({ tokenHash, used: false, expiresAt: { $gt: new Date() } });
  return token || null;
}

async function consumePasswordResetToken(tokenDoc) {
  tokenDoc.used = true;
  await tokenDoc.save();
}

module.exports = { createPasswordResetToken, verifyPasswordResetToken, consumePasswordResetToken };
