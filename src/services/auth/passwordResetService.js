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

async function consumePasswordResetToken(rawToken) {
  const tokenHash = hashToken(rawToken);
  return PasswordResetToken.findOneAndUpdate(
    { tokenHash, used: false, expiresAt: { $gt: new Date() } },
    { $set: { used: true, usedAt: new Date() } },
    { returnDocument: 'after' },
  );
}

module.exports = { createPasswordResetToken, consumePasswordResetToken };
