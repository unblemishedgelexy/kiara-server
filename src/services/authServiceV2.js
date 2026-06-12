/**
 * Authentication Service V2 - Redesigned Auth Flow
 * 
 * Key Changes:
 * 1. Registration does NOT require OTP - immediate login possible
 * 2. isVerified defaults to false
 * 3. Login allows unverified users
 * 4. Password reset with OTP auto-verifies the account
 * 5. All OTPs are hashed (security)
 */

const bcrypt = require('bcryptjs');
const UserModel = require('../models/User');
const SessionModel = require('../models/Session');
const { generateAccessToken, generateRefreshToken, hashToken } = require('./tokenService');
const otpServiceV2 = require('./otpServiceV2');
const { env } = require('../config/env');

// Email validation constants
const ALLOWED_EMAIL_DOMAINS = ['gmail.com'];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // Basic RFC 5322 validation
const DISALLOWED_EMAIL_PATTERNS = [
  /@googlemail\.com$/i,
  /@google\.com$/i,
  /@gapps\.[a-z]+$/i,
  /@.*\.edu$/i,
  /@.*\.ac\.uk$/i,
  /@.*\.school$/i,
  /@.*\.gov$/i,
];

/**
 * Validate email format strictly
 */
function validateEmailFormat(email) {
  if (!email || typeof email !== 'string') {
    return { valid: false, error: 'Email is required' };
  }

  const trimmedEmail = email.trim();
  
  // Check basic format
  if (!EMAIL_REGEX.test(trimmedEmail)) {
    return { valid: false, error: 'Invalid email format' };
  }

  // Check no spaces
  if (trimmedEmail !== trimmedEmail.trim() || trimmedEmail.includes(' ')) {
    return { valid: false, error: 'Email contains invalid characters' };
  }

  // Check domain
  const domain = trimmedEmail.split('@')[1].toLowerCase();
  if (!ALLOWED_EMAIL_DOMAINS.includes(domain)) {
    return { valid: false, error: 'Only @gmail.com email addresses are allowed' };
  }

  // Check disallowed patterns
  for (const pattern of DISALLOWED_EMAIL_PATTERNS) {
    if (pattern.test(trimmedEmail.toLowerCase())) {
      return { valid: false, error: 'This email domain is not allowed' };
    }
  }

  return { valid: true, normalizedEmail: trimmedEmail.toLowerCase() };
}

/**
 * Validate password strength
 */
function validatePassword(password) {
  if (!password || typeof password !== 'string') {
    return { valid: false, error: 'Password is required' };
  }

  if (password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters' };
  }

  return { valid: true };
}

/**
 * Hash password with bcrypt
 */
async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

/**
 * Compare password with hash
 */
async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * Sanitize user object for response
 */
function sanitizeUser(user) {
  return {
    id: user._id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    displayName: user.displayName,
    profilePicture: user.profilePicture,
    isVerified: user.isVerified,
    verifiedAt: user.verifiedAt,
    verificationMethod: user.verificationMethod,
    role: user.role,
    mode: user.mode,
    createdAt: user.createdAt,
  };
}

/**
 * ============= REGISTRATION FLOW =============
 * 
 * NEW: Registration does NOT require OTP
 * User can login immediately after registration
 * Email verification happens later via forgot-password flow
 */
async function registerUser({ firstName, lastName, email, password, mobileNumber }) {
  // Validate input

  console.log('Registering user:', { firstName, lastName, email, mobileNumber });
  if (!firstName || !lastName) {
    throw new Error('First name and last name are required.');
  }

  // Validate email
  const emailValidation = validateEmailFormat(email);
  if (!emailValidation.valid) {
    throw new Error(emailValidation.error);
  }
  const normalizedEmail = emailValidation.normalizedEmail;

  // Validate password
  const passwordValidation = validatePassword(password);
  if (!passwordValidation.valid) {
    throw new Error(passwordValidation.error);
  }

  // Check if email already exists
  const existingUser = await UserModel.findOne({ email: normalizedEmail });
  if (existingUser) {
    throw new Error('Email already registered. Please login instead.');
  }

  // Check if mobile already exists
  if (mobileNumber) {
    const existingMobile = await UserModel.findOne({ mobileNumber: mobileNumber.trim() });
    if (existingMobile) {
      throw new Error('Mobile number already registered.');
    }
  }

  // Hash password
  const passwordHash = await hashPassword(password);

  console.log('Creating user with email:', firstName, lastName, normalizedEmail, mobileNumber);
 try {
  // Create user with isVerified = false
  const user = await UserModel.create({
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    displayName: `${firstName.trim()} ${lastName.trim()}`,
    email: normalizedEmail,
    passwordHash,
    mobileNumber: mobileNumber ? mobileNumber.trim() : undefined,
    isVerified: false,      // NEW: Not verified initially
    verifiedAt: null,       // NEW: Will be set on first OTP verification
    verificationMethod: null, // NEW: Will be set to 'password_reset_otp'
    role: 'user',
    mode: 'registered',
    isActive: true,
  });

  if (!user) {
    throw new Error('Failed to create user. Please try again.');
  }

  // Generate tokens for immediate login
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
  } catch (error) {
    console.error('Error during user creation:', error.message);
    throw new Error('Failed to create user. Please try again.');
  }
}

/**
 * ============= LOGIN FLOW =============
 * 
 * UPDATED: Login allows unverified users
 * Verification happens later via forgot-password flow
 */
async function loginWithEmailPassword(email, password, ipAddress = null) {
  // Validate input
  if (!email || !password) {
    throw new Error('Email and password are required.');
  }

  // Validate email format
  const emailValidation = validateEmailFormat(email);
  if (!emailValidation.valid) {
    throw new Error('Invalid email format.');
  }
  const normalizedEmail = emailValidation.normalizedEmail;

  // Find user
  const user = await UserModel.findOne({ email: normalizedEmail });
  if (!user) {
    // Account enumeration protection
    throw new Error('Invalid email or password.');
  }

  // Check if account is active
  if (!user.isActive) {
    throw new Error('Account is inactive. Please contact support.');
  }

  // Check if account is locked (failed login attempts)
  if (user.loginLockedUntil && user.loginLockedUntil > new Date()) {
    const minutesLeft = Math.ceil((user.loginLockedUntil - new Date()) / 60000);
    throw new Error(`Account temporarily locked. Try again in ${minutesLeft} minutes.`);
  }

  // Verify password
  const passwordValid = await comparePassword(password, user.passwordHash);
  if (!passwordValid) {
    // Record failed attempt
    user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;

    // Lock account after 5 failed attempts
    if (user.failedLoginAttempts >= 5) {
      user.loginLockedUntil = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
      console.warn(`Account ${normalizedEmail} locked after 5 failed login attempts`);
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
  await createSession(user._id, refreshToken, { ipAddress });

  return {
    success: true,
    user: sanitizeUser(user),
    accessToken,
    refreshToken,
  };
}

/**
 * ============= FORGOT PASSWORD FLOW =============
 * 
 * Step 1: Request OTP for password reset
 */
async function requestPasswordResetOTP(email, ipAddress = null) {
  // Validate email format
  const emailValidation = validateEmailFormat(email);
  if (!emailValidation.valid) {
    // Account enumeration protection: return same message
    return {
      success: true,
      message: 'OTP sent to your email if account exists',
    };
  }
  const normalizedEmail = emailValidation.normalizedEmail;

  // Check if user exists
  const user = await UserModel.findOne({ email: normalizedEmail });
  if (!user) {
    // Account enumeration protection
    return {
      success: true,
      message: 'OTP sent to your email if account exists',
    };
  }

  try {
    // Create and send OTP
    const result = await otpServiceV2.createAndSendOTP(
      normalizedEmail,
      'FORGOT_PASSWORD_EMAIL',
      { ipAddress }
    );

    return {
      success: true,
      message: 'OTP sent to your email',
      expiresIn: result.expiresIn,
    };
  } catch (error) {
    console.error('Failed to create/send OTP:', error.message);
    // Return generic message to protect account enumeration
    return {
      success: true,
      message: 'OTP sent to your email if account exists',
    };
  }
}

/**
 * ============= OTP VERIFICATION FOR PASSWORD RESET =============
 * 
 * Step 2: Verify OTP and reset password
 * AUTO-VERIFIES account on success
 */
async function verifyOTPAndResetPassword(email, otpCode, newPassword) {
  // Validate email format
  const emailValidation = validateEmailFormat(email);
  if (!emailValidation.valid) {
    throw new Error('Invalid email format.');
  }
  const normalizedEmail = emailValidation.normalizedEmail;

  // Validate new password
  const passwordValidation = validatePassword(newPassword);
  if (!passwordValidation.valid) {
    throw new Error(passwordValidation.error);
  }

  // Find user
  const user = await UserModel.findOne({ email: normalizedEmail });
  if (!user) {
    // Account enumeration protection
    throw new Error('Invalid or expired OTP.');
  }

  // Verify OTP
  const verification = await otpServiceV2.verifyOTPCode(
    normalizedEmail,
    otpCode,
    'FORGOT_PASSWORD_EMAIL'
  );

  if (!verification.success) {
    throw new Error(verification.message);
  }

  // Hash new password
  const passwordHash = await hashPassword(newPassword);

  // Update user password and AUTO-VERIFY
  user.passwordHash = passwordHash;
  user.isVerified = true;                    // AUTO-VERIFY
  user.verifiedAt = new Date();              // Set verification timestamp
  user.verificationMethod = 'password_reset_otp'; // Track how verified
  user.refreshTokenHash = null;              // Force re-login
  user.failedLoginAttempts = 0;              // Reset login attempts
  user.loginLockedUntil = null;              // Clear any lock

  await user.save();

  // Invalidate all existing sessions (force re-login)
  await SessionModel.deleteMany({ userId: user._id });

  console.info(`User ${normalizedEmail} verified via password reset OTP`);

  return {
    success: true,
    message: 'Password reset successful. Your account is now verified. Please login with your new password.',
    user: sanitizeUser(user),
    verificationMethod: 'password_reset_otp',
  };
}

/**
 * ============= SESSION MANAGEMENT =============
 */
async function createSession(userId, refreshToken, opts = {}) {
  const refreshTokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
  const session = await SessionModel.create({
    userId,
    refreshTokenHash,
    expiresAt,
    ...opts,
  });
  return session;
}

async function refreshAccessToken(userId, refreshToken) {
  const refreshTokenHash = hashToken(refreshToken);
  const session = await SessionModel.findOne({
    userId,
    refreshTokenHash,
    expiresAt: { $gt: new Date() },
  });

  if (!session) {
    throw new Error('Refresh token invalid or expired.');
  }

  const user = await UserModel.findById(userId);
  if (!user || !user.isActive) {
    throw new Error('User not found or inactive.');
  }

  // Generate new tokens
  const newAccessToken = generateAccessToken({ sub: user._id });
  const newRefreshToken = generateRefreshToken({ sub: user._id });

  // Rotate refresh token
  await SessionModel.findByIdAndUpdate(session._id, {
    refreshTokenHash: hashToken(newRefreshToken),
  });

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    user: sanitizeUser(user),
  };
}

async function logout(userId) {
  await SessionModel.deleteMany({ userId });
  return { success: true, message: 'Logged out successfully' };
}

/**
 * ============= EMAIL VERIFICATION FROM PROFILE =============
 * 
 * Users can verify their email from profile settings
 * Step 1: Request OTP for email verification
 */
async function requestEmailVerificationOTP(userId, email, ipAddress = null) {
  // Validate email format
  const emailValidation = validateEmailFormat(email);
  if (!emailValidation.valid) {
    throw new Error(emailValidation.error);
  }
  const normalizedEmail = emailValidation.normalizedEmail;

  // Find user
  const user = await UserModel.findById(userId);
  if (!user) {
    throw new Error('User not found.');
  }

  // Check if email is already verified
  if (user.isVerified) {
    throw new Error('Your email is already verified.');
  }

  // Check if email matches user's current email
  if (user.email !== normalizedEmail) {
    throw new Error('Email does not match your registered email.');
  }

  try {
    // Create and send OTP
    const result = await otpServiceV2.createAndSendOTP(
      normalizedEmail,
      'EMAIL_VERIFICATION_OTP',
      { ipAddress, userId: userId.toString() }
    );

    return {
      success: true,
      message: 'Verification OTP sent to your email',
      expiresIn: result.expiresIn,
    };
  } catch (error) {
    console.error('Failed to send verification OTP:', error.message);
    throw new Error('Failed to send OTP. Please try again.');
  }
}

/**
 * ============= EMAIL VERIFICATION FROM PROFILE =============
 * 
 * Step 2: Verify OTP from profile
 * AUTO-VERIFIES account
 */
async function verifyEmailOTPFromProfile(userId, email, otpCode) {
  // Validate email format
  const emailValidation = validateEmailFormat(email);
  if (!emailValidation.valid) {
    throw new Error('Invalid email format.');
  }
  const normalizedEmail = emailValidation.normalizedEmail;

  // Find user
  const user = await UserModel.findById(userId);
  if (!user) {
    throw new Error('User not found.');
  }

  // Check if already verified
  if (user.isVerified) {
    throw new Error('Your email is already verified.');
  }

  // Check if email matches
  if (user.email !== normalizedEmail) {
    throw new Error('Email does not match your registered email.');
  }

  // Verify OTP
  const verification = await otpServiceV2.verifyOTPCode(
    normalizedEmail,
    otpCode,
    'EMAIL_VERIFICATION_OTP'
  );

  if (!verification.success) {
    throw new Error(verification.message);
  }

  // Update user - AUTO-VERIFY
  user.isVerified = true;
  user.verifiedAt = new Date();
  user.verificationMethod = 'email_verification_otp';
  await user.save();

  console.info(`User ${userId} verified email via profile verification OTP`);

  return {
    success: true,
    message: 'Email verified successfully!',
    user: sanitizeUser(user),
    verificationMethod: 'email_verification_otp',
  };
}

module.exports = {
  // Validation
  validateEmailFormat,
  validatePassword,
  
  // Authentication
  registerUser,
  loginWithEmailPassword,
  
  // Password reset with OTP
  requestPasswordResetOTP,
  verifyOTPAndResetPassword,
  
  // Email verification from profile
  requestEmailVerificationOTP,
  verifyEmailOTPFromProfile,
  
  // Session management
  createSession,
  refreshAccessToken,
  logout,
  
  // Utilities
  hashPassword,
  comparePassword,
  sanitizeUser,
};
