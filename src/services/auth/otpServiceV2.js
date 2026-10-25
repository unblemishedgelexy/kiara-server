const bcrypt = require('bcryptjs');
const { createHash, randomInt } = require('node:crypto');
const OTPModel = require('../../models/OTP');
const UserModel = require('../../models/User');
const { sendOTPEmail } = require('../infrastructure/emailService');
const { getRedisClient } = require('../infrastructure/redisService');

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
  return String(randomInt(0, 10 ** length)).padStart(length, '0');
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

  const redisClient = await getRedisClient();
  const identifierHash = createHash('sha256').update(`${type}:${identifier.toLowerCase()}`).digest('hex');
  const redisCount = await redisClient.eval(
    "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]); end; return n",
    { keys: [`kiara:otp-rate:${identifierHash}`], arguments: ['3600'] },
  );
  if (Number(redisCount) > MAX_OTP_REQUESTS_PER_HOUR) {
    return {
      allowed: false,
      reason: `Too many OTP requests. Maximum ${MAX_OTP_REQUESTS_PER_HOUR} OTPs per hour allowed. Please try again later.`,
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
    throw Object.assign(new Error(rateLimit.reason), { code: 'OTP_RATE_LIMITED' });
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
      await sendOTPEmail(
        normalizedIdentifier,
        code,
        options.meta?.userName || 'User',
        options.meta?.purpose,
      );
    } else if (type.includes('MOBILE')) {
      // TODO: Send SMS
    }
  } catch (error) {
    console.error('[OTP_DELIVERY_FAILED]', error?.name || error?.code || 'EmailProviderError');
    // Delete the OTP record if sending fails
    await OTPModel.deleteOne({ _id: otpDoc._id });
    throw Object.assign(new Error('Failed to send OTP. Please try again.'), { code: 'OTP_DELIVERY_FAILED' });
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
  if (!/^\d{6}$/.test(code)) {
    return { success: false, message: 'Invalid or expired OTP.' };
  }

  const now = new Date();
  const otpDoc = await OTPModel.findOne({
    identifier: normalizedIdentifier,
    type,
    used: false,
    expiresAt: { $gt: now },
  });

  if (!otpDoc) {
    return { success: false, message: 'Invalid or expired OTP.' };
  }

  if ((otpDoc.lockedUntil && otpDoc.lockedUntil > now) || otpDoc.failedAttempts >= otpDoc.maxAttempts) {
    return { success: false, message: 'Invalid or expired OTP.' };
  }

  const codeMatch = otpDoc.codeHash
    ? await verifyHashedOTPCode(code, otpDoc.codeHash)
    : false;
  if (!codeMatch) {
    const attemptCount = { $add: [{ $ifNull: ['$failedAttempts', 0] }, 1] };
    await OTPModel.findOneAndUpdate(
      {
        _id: otpDoc._id,
        used: false,
        expiresAt: { $gt: now },
        failedAttempts: { $lt: otpDoc.maxAttempts },
        $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
      },
      [{
        $set: {
          failedAttempts: attemptCount,
          lockedUntil: {
            $cond: [
              { $gte: [attemptCount, otpDoc.maxAttempts] },
              new Date(now.getTime() + OTP_ATTEMPT_LOCKOUT_MS),
              '$lockedUntil',
            ],
          },
          updatedAt: now,
        },
      }],
      { returnDocument: 'after' },
    );
    return { success: false, message: 'Invalid or expired OTP.' };
  }

  const consumedOTP = await OTPModel.findOneAndUpdate(
    {
      _id: otpDoc._id,
      used: false,
      expiresAt: { $gt: now },
      failedAttempts: { $lt: otpDoc.maxAttempts },
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
    },
    { $set: { used: true, usedAt: now } },
    { returnDocument: 'after' },
  );
  if (!consumedOTP) {
    return { success: false, message: 'Invalid or expired OTP.' };
  }

  return {
    success: true,
    message: 'OTP verified successfully.',
    otpDoc: consumedOTP,
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
