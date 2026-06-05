const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const UserModel = require('../models/User');
const SessionModel = require('../models/Session');
const { generateAccessToken, generateRefreshToken, hashToken } = require('./tokenService');
const { env } = require('../config/env');

const googleClient = new OAuth2Client(env.googleClientId || '');

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

async function createUser({ firstName, lastName, email, password, mobileNumber, googleId, profilePicture, mode = 'registered' }) {
  const existingEmail = email ? await UserModel.findOne({ email: email.toLowerCase() }) : null;
  if (existingEmail) {
    throw new Error('Email already in use.');
  }
  const existingMobile = mobileNumber ? await UserModel.findOne({ mobileNumber }) : null;
  if (existingMobile) {
    throw new Error('Mobile number already in use.');
  }

  const passwordHash = password ? await hashPassword(password) : undefined;
  return UserModel.create({
    firstName,
    lastName,
    displayName: mode === 'guest' ? `Guest ${Math.floor(Math.random() * 10000)}` : `${firstName || ''} ${lastName || ''}`.trim(),
    email: email?.toLowerCase(),
    emailVerified: false,
    mobileNumber,
    mobileVerified: false,
    passwordHash,
    profilePicture,
    googleId,
    role: 'user',
    mode,
  });
}

async function findUserByEmail(email) {
  return UserModel.findOne({ email: email.toLowerCase() });
}

async function findUserByMobile(mobileNumber) {
  return UserModel.findOne({ mobileNumber });
}

async function findUserByGoogleId(googleId) {
  return UserModel.findOne({ googleId });
}

async function createSession(userId, refreshToken, opts = {}) {
  const refreshTokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const session = await SessionModel.create({ userId, refreshTokenHash, expiresAt, ...opts });
  await UserModel.findByIdAndUpdate(userId, { refreshTokenHash }, { returnDocument: 'after' });
  return session;
}

async function loginWithEmail(email, password) {
  const user = await findUserByEmail(email);
  if (!user || !user.passwordHash) {
    throw new Error('Invalid credentials');
  }
  const valid = await comparePassword(password, user.passwordHash);
  if (!valid) {
    throw new Error('Invalid credentials');
  }
  if (!user.emailVerified || !user.mobileVerified) {
    throw new Error('Please verify email and mobile before logging in.');
  }
  const accessToken = generateAccessToken({ sub: user._id });
  const refreshToken = generateRefreshToken({ sub: user._id });
  await createSession(user._id, refreshToken);
  return { user, accessToken, refreshToken };
}

async function loginWithGoogleToken(idToken, mobileNumber) {
  if (!idToken) {
    throw new Error('Google ID token is required.');
  }

  const ticket = await googleClient.verifyIdToken({ idToken, audience: env.googleClientId });
  const payload = ticket.getPayload();
  const googleId = payload.sub;
  const email = payload.email?.toLowerCase();
  const firstName = payload.given_name || payload.name?.split(' ')[0] || '';
  const lastName = payload.family_name || payload.name?.split(' ').slice(1).join(' ') || '';

  let user = await findUserByGoogleId(googleId);
  if (!user && email) {
    user = await findUserByEmail(email);
  }

  if (!user) {
    user = await UserModel.create({
      firstName,
      lastName,
      email,
      emailVerified: true,
      mobileNumber: mobileNumber || undefined,
      mobileVerified: false,
      googleId,
      role: 'user',
    });
  } else {
    user.googleId = googleId;
    if (email) user.email = email;
    if (firstName) user.firstName = firstName;
    if (lastName) user.lastName = lastName;
    await user.save();
  }

  if (!user.mobileVerified) {
    return { user, pendingMobileVerification: true };
  }

  const accessToken = generateAccessToken({ sub: user._id });
  const refreshToken = generateRefreshToken({ sub: user._id });
  await createSession(user._id, refreshToken);
  return { user, accessToken, refreshToken, pendingMobileVerification: false };
}

async function ensureGuestUser(userId) {
  if (userId) {
    const existing = await UserModel.findById(userId);
    if (existing) return existing;
  }
  return createUser({ mode: 'guest' });
}

async function refreshSession(userId, refreshToken, userAgent, ip) {
  const refreshTokenHash = hashToken(refreshToken);
  const session = await SessionModel.findOne({ userId, refreshTokenHash, expiresAt: { $gt: new Date() } });
  if (!session) {
    throw new Error('Refresh token invalid or expired.');
  }
  const newRefreshToken = generateRefreshToken({ sub: userId });
  session.refreshTokenHash = hashToken(newRefreshToken);
  session.expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  session.userAgent = userAgent;
  session.ip = ip;
  await session.save();
  await UserModel.findByIdAndUpdate(userId, { refreshTokenHash: session.refreshTokenHash });
  const accessToken = generateAccessToken({ sub: userId });
  return { accessToken, refreshToken: newRefreshToken };
}

async function logout(userId, refreshToken) {
  const refreshTokenHash = hashToken(refreshToken);
  await SessionModel.deleteOne({ userId, refreshTokenHash });
}

async function invalidateAllSessions(userId) {
  await SessionModel.deleteMany({ userId });
  await UserModel.findByIdAndUpdate(userId, { refreshTokenHash: null });
}

module.exports = {
  hashPassword,
  comparePassword,
  createUser,
  ensureGuestUser,
  findUserByEmail,
  findUserByMobile,
  findUserByGoogleId,
  createSession,
  loginWithEmail,
  loginWithGoogleToken,
  refreshSession,
  logout,
  invalidateAllSessions,
};
