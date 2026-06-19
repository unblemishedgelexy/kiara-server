const bcrypt = require('bcryptjs');
const UserModel = require('../../models/User');
const OTPModel = require('../../models/OTP');
const SessionModel = require('../../models/Session');
const { generateAccessToken, generateRefreshToken, hashToken } = require('./tokenService');
const otpService = require('./otpService');
const { env } = require('../../config/env');

// PRODUCTION RULES:
// 1. Only @gmail.com accounts are allowed
// 2. Reject Google Workspace, business, educational, and custom-domain emails
// 3. OTP-based email verification
// 4. Password-based login with email
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

function generateOTPCode(length = 6) {
  return String(Math.floor(Math.random() * Math.pow(10, length))).padStart(length, '0');
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// ============= REGISTRATION FLOW =============
async function registerUser({ firstName, lastName, email, password, mobileNumber }) {
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
  
  // Check if email already exists
  const existingEmail = await UserModel.findOne({ email: normalizedEmail });
  if (existingEmail) {
    throw new Error('Email already registered. Please login instead.');
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
  
  // Create user and mark as verified immediately for direct registration
  const user = await UserModel.create({
    firstName,
    lastName,
    displayName: `${firstName} ${lastName}`.trim(),
    email: normalizedEmail,
    emailVerified: true,
    mobileNumber: mobileNumber || undefined,
    mobileVerified: Boolean(mobileNumber),
    passwordHash,
    role: 'user',
    mode: 'registered',
  });
  
  // Generate tokens for immediate login if registration succeeds
  const accessToken = generateAccessToken({ sub: user._id });
  const refreshToken = generateRefreshToken({ sub: user._id });
  await createSession(user._id, refreshToken);

  return {
    success: true,
    message: 'Registration successful. You can login immediately.',
    user: sanitizeUser(user),
    accessToken,
    refreshToken,
  };
}

// ============= OTP FUNCTIONS =============
async function generateAndSendOTP(email, type = 'REGISTER_EMAIL') {
  // Validate Gmail
  if (!isValidGmailAccount(email)) {
    throw new Error('Only @gmail.com email accounts are allowed.');
  }
  
  // Generate OTP code
  const code = generateOTPCode(6);
  
  // Delete any existing OTP for this email
  await OTPModel.deleteMany({ identifier: email.toLowerCase(), type });
  
  // Create new OTP
  const otp = await OTPModel.create({
    identifier: email.toLowerCase(),
    code,
    type,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
  });
  
  // Send OTP via email using shared OTP service
  try {
    await otpService.sendOTP(email, type, code);
  } catch (error) {
    console.error('Failed to send OTP:', error);
    throw new Error('Failed to send OTP. Please try again.');
  }
  
  return otp;
}

async function verifyOTP(email, code, type = 'REGISTER_EMAIL') {
  const normalizedEmail = email.toLowerCase();
  
  // Find OTP
  const otp = await OTPModel.findOne({
    identifier: normalizedEmail,
    code,
    type,
    expiresAt: { $gt: new Date() },
    used: false,
  });
  
  if (!otp) {
    throw new Error('Invalid or expired OTP code.');
  }
  
  // Mark as used
  otp.used = true;
  await otp.save();
  
  // For registration, mark email as verified
  if (type === 'REGISTER_EMAIL') {
    await UserModel.findOneAndUpdate(
      { email: normalizedEmail },
      { emailVerified: true },
      { returnDocument: 'after' }
    );
  }
  
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
    failedOtpAttempts,
    accountLockedUntil,
    failedLoginAttempts,
    loginLockedUntil,
    ...safe
  } = obj;
  return safe;
}

// ============= FORGOT PASSWORD FUNCTIONS =============
async function sendForgotPasswordOTP(email) {
  const normalizedEmail = email.toLowerCase();
  
  // Validate Gmail
  if (!isValidGmailAccount(normalizedEmail)) {
    throw new Error('Only @gmail.com email accounts are allowed.');
  }
  
  // Find user by email
  const user = await UserModel.findOne({ email: normalizedEmail });
  if (!user) {
    // Don't reveal if email exists (security best practice)
    throw new Error('If this email is registered, you will receive password reset instructions.');
  }
  
  // Generate OTP code
  const code = generateOTPCode(6);
  
  // Delete any existing OTP for this email
  await OTPModel.deleteMany({ identifier: normalizedEmail, type: 'FORGOT_PASSWORD_EMAIL' });
  
  // Create new OTP
  const otp = await OTPModel.create({
    identifier: normalizedEmail,
    code,
    type: 'FORGOT_PASSWORD_EMAIL',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
  });
  
  // Send OTP via email
  try {
    await otpService.sendOTP(normalizedEmail, 'FORGOT_PASSWORD_EMAIL', code);
  } catch (error) {
    console.error('Failed to send OTP:', error);
    throw new Error('Failed to send OTP. Please try again.');
  }
  
  return otp;
}

async function verifyForgotPasswordOTP(email, code) {
  const normalizedEmail = email.toLowerCase();
  
  // Find OTP
  const otp = await OTPModel.findOne({
    identifier: normalizedEmail,
    code,
    type: 'FORGOT_PASSWORD_EMAIL',
    expiresAt: { $gt: new Date() },
    used: false,
  });
  
  if (!otp) {
    throw new Error('Invalid or expired OTP code.');
  }
  
  // Mark as used
  otp.used = true;
  await otp.save();
  
  return true;
}

async function resetPassword(email, newPassword) {
  if (!email || !newPassword) {
    throw new Error('Email and password are required.');
  }
  
  if (newPassword.length < 8) {
    throw new Error('Password must be at least 8 characters long.');
  }
  
  const normalizedEmail = email.toLowerCase();
  
  // Find user
  const user = await UserModel.findOne({ email: normalizedEmail });
  if (!user) {
    throw new Error('User not found.');
  }
  
  // Hash new password
  const newPasswordHash = await hashPassword(newPassword);
  
  // Update password
  user.passwordHash = newPasswordHash;
  user.failedLoginAttempts = 0;
  user.loginLockedUntil = null;
  await user.save();
  
  return true;
}

// ============= GOOGLE OAUTH =============
async function loginWithGoogle({ googleId, email, firstName, lastName, profilePicture, googleEmail }) {
  if (!googleId || !email) {
    throw new Error('Google ID and email are required.');
  }

  const normalizedEmail = email.toLowerCase();

  try {
    // Find user by googleId first
    let user = await UserModel.findOne({ googleId });

    if (user) {
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

      existingUser.googleId = googleId;
      existingUser.googleEmail = googleEmail || normalizedEmail;
      existingUser.emailVerified = true;
      existingUser.profilePicture = profilePicture || existingUser.profilePicture;
      existingUser.firstName = existingUser.firstName || firstName || existingUser.firstName;
      existingUser.lastName = existingUser.lastName || lastName || existingUser.lastName;
      existingUser.displayName = existingUser.displayName || `${existingUser.firstName || ''} ${existingUser.lastName || ''}`.trim();
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
      passwordHash: await hashPassword(Math.random().toString(36).slice(-16)),
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
    console.error('Google login error:', error);
    throw error;
  }
}

module.exports = {
  // Registration
  registerUser,
  
  // OTP
  generateAndSendOTP,
  verifyOTP,
  
  // Login
  loginWithEmailPassword,
  loginWithGoogle,
  
  // Forgot Password
  sendForgotPasswordOTP,
  verifyForgotPasswordOTP,
  resetPassword,
  
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
