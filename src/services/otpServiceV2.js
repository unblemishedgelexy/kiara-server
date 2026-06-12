const bcrypt = require('bcryptjs');
const OTPModel = require('../models/OTP');
const UserModel = require('../models/User');
const { sendOTPEmail } = require('./emailService');

// Constants
const OTP_LENGTH = 6;
const OTP_VALIDITY_SECONDS = 10 * 60; // 10 minutes
const MAX_OTP_ATTEMPTS = 5; // Max failed verification attempts
const OTP_ATTEMPT_LOCKOUT_MS = 30 * 60 * 1000; // 30 minutes lockout after max attempts
const MAX_OTP_REQUESTS_PER_HOUR = 5; // Max OTP creation requests per hour per identifier

/**
 * Generate a random OTP code
 */
function generateOTPCode(length = OTP_LENGTH) {
  return String(Math.floor(Math.random() * Math.pow(10, length)))
    .padStart(length, '0');
}

/**
 * Hash OTP code using bcrypt
 */
async function hashOTPCode(code) {
  return bcrypt.hash(code, 10);
}

/**
 * Compare OTP code with hash
 */
async function verifyHashedOTPCode(code, hash) {
  return bcrypt.compare(code, hash);
}

/**
 * Check rate limiting for OTP creation
 * Returns { allowed: boolean, reason?: string }
 */
async function checkOTPCreationRateLimit(identifier, type) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  
  const recentOTPs = await OTPModel.countDocuments({
    identifier: identifier.toLowerCase(),
    type,
    createdAt: { $gte: oneHourAgo },
  });

  if (recentOTPs >= MAX_OTP_REQUESTS_PER_HOUR) {
    return {
      allowed: false,
      reason: `Too many OTP requests. Maximum ${MAX_OTP_REQUESTS_PER_HOUR} OTPs per hour allowed. Please try again later.`
    };
  }

  return { allowed: true };
}

/**
 * Create and send OTP
 * 
 * @param {string} identifier - email or phone
 * @param {string} type - OTP type (FORGOT_PASSWORD_EMAIL, etc)
 * @param {object} options - { ipAddress, userAgent }
 * @returns {object} { success: boolean, message: string, expiresIn: number }
 */
async function createAndSendOTP(identifier, type, options = {}) {
  const normalizedIdentifier = identifier.toLowerCase().trim();

  // Rate limiting check
  const rateLimit = await checkOTPCreationRateLimit(normalizedIdentifier, type);
  if (!rateLimit.allowed) {
    throw new Error(rateLimit.reason);
  }

  // Delete any existing unexpired OTP for this identifier+type
  await OTPModel.deleteMany({
    identifier: normalizedIdentifier,
    type,
    expiresAt: { $gt: new Date() },
  });

  // Generate OTP
  const code = generateOTPCode();
  const codeHash = await hashOTPCode(code);
  
  // Calculate expiry
  const expiresAt = new Date(Date.now() + OTP_VALIDITY_SECONDS * 1000);

  // Create OTP record
  const otpDoc = await OTPModel.create({
    identifier: normalizedIdentifier,
    codeHash,
    type,
    expiresAt,
    ipAddress: options.ipAddress || null,
    userAgent: options.userAgent || null,
    failedAttempts: 0,
    maxAttempts: MAX_OTP_ATTEMPTS,
    meta: options.meta || {},
  });

  // Send OTP via email/SMS
  try {
    if (type.includes('EMAIL')) {
      await sendOTPEmail(normalizedIdentifier, code, options.meta?.userName || 'User');
    } else if (type.includes('MOBILE')) {
      // TODO: Send SMS
      console.log(`[DEV] OTP for ${normalizedIdentifier}: ${code}`);
    }
  } catch (error) {
    console.error('Failed to send OTP:', error);
    // Delete the OTP record if sending fails
    await OTPModel.deleteOne({ _id: otpDoc._id });
    throw new Error('Failed to send OTP. Please try again.');
  }

  return {
    success: true,
    message: `OTP sent to ${normalizedIdentifier}`,
    expiresIn: OTP_VALIDITY_SECONDS,
    otpId: otpDoc._id,
  };
}

/**
 * Verify OTP code
 * Returns { success: boolean, message: string, otpDoc?: object }
 */
async function verifyOTPCode(identifier, code, type) {
  const normalizedIdentifier = identifier.toLowerCase().trim();

  // Find OTP record
  const otpDoc = await OTPModel.findOne({
    identifier: normalizedIdentifier,
    type,
  });

  // OTP not found
  if (!otpDoc) {
    // Account enumeration protection: return generic message
    return {
      success: false,
      message: 'Invalid or expired OTP.',
    };
  }

  // OTP expired
  if (otpDoc.expiresAt < new Date()) {
    return {
      success: false,
      message: 'OTP has expired. Please request a new one.',
    };
  }

  // OTP already used
  if (otpDoc.used) {
    return {
      success: false,
      message: 'OTP has already been used.',
    };
  }

  // Check if OTP is locked (too many failed attempts)
  if (otpDoc.lockedUntil && otpDoc.lockedUntil > new Date()) {
    const minutesLeft = Math.ceil((otpDoc.lockedUntil - new Date()) / 60000);
    return {
      success: false,
      message: `Too many failed attempts. Please try again in ${minutesLeft} minutes.`,
    };
  }

  // Verify OTP code
  const codeMatch = await verifyHashedOTPCode(code, otpDoc.codeHash);
  if (!codeMatch) {
    // Increment failed attempts
    otpDoc.failedAttempts += 1;

    // Lock OTP if max attempts reached
    if (otpDoc.failedAttempts >= otpDoc.maxAttempts) {
      otpDoc.lockedUntil = new Date(Date.now() + OTP_ATTEMPT_LOCKOUT_MS);
      await otpDoc.save();
      return {
        success: false,
        message: `Too many failed attempts. OTP locked for 30 minutes.`,
      };
    }

    await otpDoc.save();
    return {
      success: false,
      message: 'Invalid OTP code.',
    };
  }

  // OTP verified successfully
  otpDoc.used = true;
  otpDoc.usedAt = new Date();
  await otpDoc.save();

  return {
    success: true,
    message: 'OTP verified successfully.',
    otpDoc,
  };
}

/**
 * Get OTP verification status
 */
async function getOTPStatus(identifier, type) {
  const otpDoc = await OTPModel.findOne({
    identifier: identifier.toLowerCase(),
    type,
  });

  if (!otpDoc) {
    return { exists: false };
  }

  return {
    exists: true,
    used: otpDoc.used,
    expiresAt: otpDoc.expiresAt,
    failedAttempts: otpDoc.failedAttempts,
    locked: otpDoc.lockedUntil && otpDoc.lockedUntil > new Date(),
  };
}

/**
 * Clean up expired OTPs (can be called periodically)
 */
async function cleanupExpiredOTPs() {
  const result = await OTPModel.deleteMany({
    expiresAt: { $lt: new Date() },
  });
  return result.deletedCount;
}

module.exports = {
  generateOTPCode,
  hashOTPCode,
  verifyOTPCode,
  createAndSendOTP,
  getOTPStatus,
  cleanupExpiredOTPs,
  MAX_OTP_ATTEMPTS,
  OTP_VALIDITY_SECONDS,
};
