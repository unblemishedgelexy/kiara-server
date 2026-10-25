const bcrypt = require('bcryptjs');
const { randomBytes } = require('node:crypto');
const UserModel = require('../../models/User');
const LEGAL_TERMS_VERSION = 'terms-draft-2026-10-24';
const LEGAL_PRIVACY_VERSION = 'privacy-draft-2026-10-24';
const SessionModel = require('../../models/Session');
const { generateAccessToken, generateRefreshToken, hashToken } = require('./tokenService');
const otpService = require('./otpServiceV2');
const { env } = require('../../config/env');
const accountDeletionService = require('../accountDeletionService');

// PRODUCTION RULES:
// 1. Direct email/password accounts must use @gmail.com
// 2. Direct registration requires email OTP verification
// 3. Google OAuth accepts the provider-verified email address
const ALLOWED_EMAIL_DOMAINS = ['gmail.com'];
const DISALLOWED_EMAIL_PATTERNS = [
  /@googlemail\.com$/,
  /@google\.com$/,
  /@gapps\.[a-z]+$/,
  /@collegeName\..*\.edu$/,
  /@.*\.edu$/,
  /@.*\.ac\.uk$/,
  /@.*\.school$/,
  /@.*\.gov$/,
];

function isValidGmailAccount(email) {
  if (!email) return false;
  const emailLower = email.toLowerCase();
  const domain = emailLower.split('@')[1];
  
  // Check if domain is in allowed list
  if (!ALLOWED_EMAIL_DOMAINS.includes(domain)) {
    return false;
  }
  
  // Check against disallowed patterns
  for (const pattern of DISALLOWED_EMAIL_PATTERNS) {
    if (pattern.test(emailLower)) {
      return false;
    }
  }
  
  return true;
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// ============= REGISTRATION FLOW =============
async function registerUser({
  firstName,
  lastName,
  email,
  password,
  mobileNumber,
  ipAddress,
  userAgent,
}) {
  // Validate input
  if (!email || !password) {
    throw new Error('Email and password are required.');
  }
  
  if (!firstName || !lastName) {
    throw new Error('First name and last name are required.');
  }
  
  // Validate Gmail account
  if (!isValidGmailAccount(email)) {
    throw new Error('Only @gmail.com email accounts are allowed. Please use a Gmail account to register.');
  }
  
  const normalizedEmail = email.toLowerCase();
  
  const existingEmail = await UserModel.findOne({ email: normalizedEmail });
  if (existingEmail?.emailVerified) {
    throw new Error('Email already registered. Please login instead.');
  }
  if (existingEmail) {
    await UserModel.deleteOne({ _id: existingEmail._id, emailVerified: { $ne: true } });
  }
  
  // Check if mobile already exists
  if (mobileNumber) {
    const existingMobile = await UserModel.findOne({ mobileNumber });
    if (existingMobile) {
      throw new Error('Mobile number already registered.');
    }
  }
  
  // Hash password
  const passwordHash = await hashPassword(password);
  
  // Account access is withheld until the email challenge has been completed.
  const user = await UserModel.create({
    firstName,
    lastName,
    displayName: `${firstName} ${lastName}`.trim(),
    email: normalizedEmail,
    emailVerified: false,
    mobileNumber: mobileNumber || undefined,
    mobileVerified: Boolean(mobileNumber),
    passwordHash,
    passwordLoginEnabled: true,
    role: 'user',
    mode: 'registered',
  });
  
  await otpService.createAndSendOTP(normalizedEmail, 'REGISTER_EMAIL', {
    ipAddress,
    userAgent,
    meta: { userName: user.firstName || 'User' },
  });

  return {
    success: true,
    message: 'Registration started. Verify your email before logging in.',
    user: sanitizeUser(user),
  };
}

// ============= OTP FUNCTIONS =============
async function generateAndSendOTP(email, type = 'REGISTER_EMAIL', options = {}) {
  // Validate Gmail
  if (!isValidGmailAccount(email)) {
    throw new Error('Only @gmail.com email accounts are allowed.');
  }
  
  if (type !== 'REGISTER_EMAIL') {
    throw new Error('Unsupported OTP type.');
  }

  const user = await UserModel.findOne({ email: email.toLowerCase(), emailVerified: false });
  if (!user) throw new Error('No pending email verification was found.');
  return otpService.createAndSendOTP(email, type, {
    ipAddress: options.ipAddress,
    userAgent: options.userAgent,
    meta: { userName: user.firstName || 'User' },
  });
}

async function verifyOTP(email, code, type = 'REGISTER_EMAIL') {
  const normalizedEmail = email.toLowerCase();
  if (type !== 'REGISTER_EMAIL') {
    throw new Error('Unsupported OTP type.');
  }
  const user = await UserModel.findOne({ email: normalizedEmail, emailVerified: false });
  if (!user) throw new Error('Invalid or expired OTP code.');
  const result = await otpService.verifyOTPCode(normalizedEmail, code, type);
  if (!result.success) throw new Error(result.message);
  await UserModel.updateOne({ _id: user._id, emailVerified: false }, { $set: { emailVerified: true } });
  return true;
}

// ============= LOGIN FUNCTIONS =============
async function loginWithEmailPassword(email, password) {
  if (!email || !password) {
    throw new Error('Email and password are required.');
  }
  
  const normalizedEmail = email.toLowerCase();
  
  // Validate Gmail
  if (!isValidGmailAccount(normalizedEmail)) {
    throw new Error('Only @gmail.com email accounts are allowed.');
  }
  
  // Find user
  const user = await UserModel.findOne({ email: normalizedEmail });
  if (!user) {
    throw new Error('Invalid email or password.');
  }
  
  // Check if account is locked
  if (user.loginLockedUntil && user.loginLockedUntil > new Date()) {
    throw new Error('Account is temporarily locked. Please try again later.');
  }
  
  // Verify password
  const passwordValid = await comparePassword(password, user.passwordHash);
  if (!passwordValid) {
    // Record failed attempt
    user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
    
    // Lock account after 5 failed attempts
    if (user.failedLoginAttempts >= 5) {
      user.loginLockedUntil = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
    }
    
    await user.save();
    throw new Error('Invalid email or password.');
  }

  if (!user.emailVerified) {
    throw new Error('Please verify your email before logging in.');
  }

  await accountDeletionService.cancelDeletionAfterLogin(user);
  
  // Reset failed attempts on successful login
  user.failedLoginAttempts = 0;
  user.loginLockedUntil = null;
  user.lastLogin = new Date();
  await user.save();
  
  // Generate tokens
  const accessToken = generateAccessToken({ sub: user._id });
  const refreshToken = generateRefreshToken({ sub: user._id });
  await createSession(user._id, refreshToken);
  
  return { user, accessToken, refreshToken };
}

// ============= SESSION FUNCTIONS =============
async function createSession(userId, refreshToken, opts = {}) {
  const refreshTokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
  const session = await SessionModel.create({ userId, refreshTokenHash, expiresAt, ...opts });
  await UserModel.findByIdAndUpdate(userId, { refreshTokenHash }, { returnDocument: 'after' });
  return session;
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
  if (!userId) return;
  await SessionModel.deleteMany({ userId });
  await UserModel.findByIdAndUpdate(userId, { refreshTokenHash: null });
}

// ============= UTILITY FUNCTIONS =============
async function findUserByEmail(email) {
  if (!email) return null;
  return UserModel.findOne({ email: email.toLowerCase() });
}

async function findUserById(id) {
  if (!id) return null;
  return UserModel.findById(id);
}

function sanitizeUser(user) {
  if (!user) return null;
  const obj = user.toObject ? user.toObject() : user;
  const {
    passwordHash,
    refreshTokenHash,
    __v,
    googleEmail,
    profilePictureFileId,
    failedOtpAttempts,
    accountLockedUntil,
    failedLoginAttempts,
    loginLockedUntil,
    ...safe
  } = obj;
  return {
    ...safe,
    sensitiveActionRequiresPassword: user.passwordLoginEnabled === true
      || (!user.googleId && user.passwordLoginEnabled !== false),
  };
}

// ============= FORGOT PASSWORD FUNCTIONS =============
async function sendForgotPasswordOTP(email, options = {}) {
  const normalizedEmail = email.toLowerCase();
  
  // Validate Gmail
  if (!isValidGmailAccount(normalizedEmail)) {
    throw new Error('Only @gmail.com email accounts are allowed.');
  }
  
  // Find user by email
  const user = await UserModel.findOne({ email: normalizedEmail });
  if (!user) {
    return { success: true };
  }
  await otpService.createAndSendOTP(normalizedEmail, 'FORGOT_PASSWORD_EMAIL', options);
  return { success: true };
}

async function resetPasswordWithOtp(email, code, newPassword) {
  if (!email || !code || !newPassword) {
    throw new Error('Email, OTP, and password are required.');
  }
  
  if (newPassword.length < 8) {
    throw new Error('Password must be at least 8 characters long.');
  }
  
  const normalizedEmail = email.toLowerCase();
  
  const user = await UserModel.findOne({ email: normalizedEmail });
  if (!user) throw new Error('Invalid or expired OTP code.');

  const verification = await otpService.verifyOTPCode(normalizedEmail, code, 'FORGOT_PASSWORD_EMAIL');
  if (!verification.success) throw new Error(verification.message);

  const newPasswordHash = await hashPassword(newPassword);
  user.passwordHash = newPasswordHash;
  user.passwordLoginEnabled = true;
  user.failedLoginAttempts = 0;
  user.loginLockedUntil = null;
  user.emailVerified = true;
  await user.save();
  await invalidateAllSessions(user._id);
  return true;
}

// ============= GOOGLE OAUTH =============
async function loginWithGoogle({
  googleId,
  email,
  firstName,
  lastName,
  profilePicture,
  googleEmail,
}) {
  if (!googleId || !email) {
    throw new Error('Google ID and email are required.');
  }

  const normalizedEmail = email.toLowerCase();
  if (googleEmail && googleEmail.toLowerCase() !== normalizedEmail) {
    throw new Error('Verified Google email does not match the account email.');
  }

  try {
    // Find user by googleId first
    let user = await UserModel.findOne({ googleId });

    if (user) {
      await accountDeletionService.cancelDeletionAfterLogin(user);
      // User exists - update last login and profile data
      user.lastLogin = new Date();
      user.emailVerified = true;
      user.googleEmail = googleEmail || normalizedEmail;
      user.profilePicture = profilePicture || user.profilePicture;
      await user.save();

      const accessToken = generateAccessToken({ sub: user._id });
      const refreshToken = generateRefreshToken({ sub: user._id });
      await createSession(user._id, refreshToken);

      return {
        user: sanitizeUser(user),
        accessToken,
        token: accessToken,
        refreshToken,
        message: 'Logged in successfully with Google.',
      };
    }

    // Link Google to existing user by email if possible
    const existingUser = await UserModel.findOne({ email: normalizedEmail });
    if (existingUser) {
      if (existingUser.googleId && existingUser.googleId !== googleId) {
        throw new Error('This email is already linked to a different Google account.');
      }

      if (!existingUser.emailVerified) {
        existingUser.passwordHash = await hashPassword(randomBytes(32).toString('hex'));
        existingUser.passwordLoginEnabled = false;
        await SessionModel.deleteMany({ userId: existingUser._id });
        existingUser.refreshTokenHash = null;
      }
      existingUser.googleId = googleId;
      existingUser.googleEmail = googleEmail || normalizedEmail;
      existingUser.emailVerified = true;
      existingUser.profilePicture = profilePicture || existingUser.profilePicture;
      existingUser.firstName = existingUser.firstName || firstName || existingUser.firstName;
      existingUser.lastName = existingUser.lastName || lastName || existingUser.lastName;
      existingUser.displayName = existingUser.displayName || `${existingUser.firstName || ''} ${existingUser.lastName || ''}`.trim();
      await accountDeletionService.cancelDeletionAfterLogin(existingUser);
      await existingUser.save();

      const accessToken = generateAccessToken({ sub: existingUser._id });
      const refreshToken = generateRefreshToken({ sub: existingUser._id });
      await createSession(existingUser._id, refreshToken);

      return {
        user: sanitizeUser(existingUser),
        accessToken,
        token: accessToken,
        refreshToken,
        message: 'Google account linked and signed in successfully.',
      };
    }

    // Create a new user for this Google account
    user = await UserModel.create({
      firstName: firstName || '',
      lastName: lastName || '',
      displayName: `${firstName || ''} ${lastName || ''}`.trim(),
      email: normalizedEmail,
      emailVerified: true,
      googleId,
      googleEmail: googleEmail || normalizedEmail,
      profilePicture: profilePicture || undefined,
      passwordHash: await hashPassword(randomBytes(32).toString('hex')),
      passwordLoginEnabled: false,
      role: 'user',
      mode: 'registered',
    });

    const accessToken = generateAccessToken({ sub: user._id });
    const refreshToken = generateRefreshToken({ sub: user._id });
    await createSession(user._id, refreshToken);

    return {
      user: sanitizeUser(user),
      accessToken,
      token: accessToken,
      refreshToken,
      message: 'Account created and logged in successfully with Google.',
    };
  } catch (error) {
    console.error('[GOOGLE_LOGIN_FAILED]', error?.name || error?.code || 'OAuthError');
    throw error;
  }
}

async function acceptLegalConsent(userId) {
  const user = await UserModel.findById(userId);
  if (!user) {
    throw Object.assign(new Error('User not found.'), { code: 'USER_NOT_FOUND' });
  }

  const acceptedAt = new Date();
  user.termsVersion = LEGAL_TERMS_VERSION;
  user.termsAcceptedAt = acceptedAt;
  user.privacyVersion = LEGAL_PRIVACY_VERSION;
  user.privacyAcceptedAt = acceptedAt;
  await user.save();
  return sanitizeUser(user);
}

module.exports = {
  // Registration
  registerUser,
  acceptLegalConsent,
  
  // OTP
  generateAndSendOTP,
  verifyOTP,
  
  // Login
  loginWithEmailPassword,
  loginWithGoogle,
  
  // Forgot Password
  sendForgotPasswordOTP,
  resetPasswordWithOtp,
  
  // Session
  createSession,
  refreshSession,
  logout,
  invalidateAllSessions,
  
  // Utility
  findUserByEmail,
  findUserById,
  sanitizeUser,
  isValidGmailAccount,
  hashPassword,
  comparePassword,
};
