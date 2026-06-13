/**
 * Authentication Controller V2 - Redesigned Auth Flow
 * 
 * Endpoints:
 * POST /api/auth/register - User registration (no OTP)
 * POST /api/auth/login - User login (allows unverified)
 * POST /api/auth/forgot-password - Request password reset OTP
 * POST /api/auth/verify-otp-and-reset - Verify OTP and reset password (auto-verifies)
 * GET /api/auth/verification-status - Check account verification status
 * POST /api/auth/logout - Logout
 */

const authServiceV2 = require('../services/authServiceV2');
const { verifyRefreshToken } = require('../services/tokenService');
const UserModel = require('../models/User');

// ============= REGISTRATION =============
async function register(req, res, next) {
  try {
    const { firstName, lastName, email, password, mobileNumber } = req.body;
    console.log('Registration request:', { firstName, lastName, email, mobileNumber });

    const result = await authServiceV2.registerUser({
      firstName,
      lastName,
      email,
      password,
      mobileNumber,
    });

    res.status(201).json(result);
  } catch (error) {
    console.error('Registration error:', error.message);
    const statusCode = error.message.includes('already') ? 400 : 400;
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Registration failed.',
    });
  }
}

// ============= LOGIN =============
async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;

    const result = await authServiceV2.loginWithEmailPassword(email, password, ipAddress);

    res.json({
      success: true,
      message: 'Login successful.',
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  } catch (error) {
    console.error('Login error:', error.message);
    const statusCode = error.message.includes('locked') ? 429 : 400;
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Login failed.',
    });
  }
}

// ============= FORGOT PASSWORD - STEP 1: REQUEST OTP =============
async function forgotPassword(req, res, next) {
  try {
    const { email } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required.',
      });
    }

    const result = await authServiceV2.requestPasswordResetOTP(email, ipAddress);

    res.json(result);
  } catch (error) {
    console.error('Forgot password error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to process password reset request. Please try again.',
    });
  }
}

// ============= FORGOT PASSWORD - STEP 2: VERIFY OTP & RESET PASSWORD =============
async function verifyOTPAndResetPassword(req, res, next) {
  try {
    const { email, otpCode, newPassword } = req.body;

    if (!email || !otpCode || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Email, OTP code, and new password are required.',
      });
    }

    const result = await authServiceV2.verifyOTPAndResetPassword(
      email,
      otpCode,
      newPassword
    );

    res.json(result);
  } catch (error) {
    console.error('OTP verification error:', error.message);
    const statusCode = error.message.includes('locked') ? 429 : 400;
    res.status(statusCode).json({
      success: false,
      message: error.message || 'OTP verification failed.',
    });
  }
}

// ============= EMAIL VERIFICATION FROM PROFILE - STEP 1 =============
async function requestEmailVerificationOTP(req, res, next) {
  try {
    const { email } = req.body;
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized.',
      });
    }

    const result = await authServiceV2.requestEmailVerificationOTP(
      userId,
      email,
      req.ip || req.connection.remoteAddress
    );

    res.json(result);
  } catch (error) {
    console.error('Email verification OTP request error:', error.message);
    res.status(400).json({
      success: false,
      message: error.message || 'Failed to send verification OTP.',
    });
  }
}

// ============= EMAIL VERIFICATION FROM PROFILE - STEP 2 =============
async function verifyEmailOTPFromProfile(req, res, next) {
  try {
    const { email, otpCode } = req.body;
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized.',
      });
    }

    if (!email || !otpCode) {
      return res.status(400).json({
        success: false,
        message: 'Email and OTP code are required.',
      });
    }

    const result = await authServiceV2.verifyEmailOTPFromProfile(
      userId,
      email,
      otpCode
    );

    res.json(result);
  } catch (error) {
    console.error('Profile email verification error:', error.message);
    const statusCode = error.message.includes('locked') ? 429 : 400;
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Email verification failed.',
    });
  }
}

// ============= VERIFICATION STATUS =============
async function getVerificationStatus(req, res, next) {
  try {
    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized.',
      });
    }

    const user = await UserModel.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    res.json({
      success: true,
      isVerified: user.isVerified,
      verifiedAt: user.verifiedAt,
      verificationMethod: user.verificationMethod,
      email: user.email,
    });
  } catch (error) {
    console.error('Verification status error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to get verification status.',
    });
  }
}

// ============= LOGOUT =============
async function logout(req, res, next) {
  try {
    // Allow logout via authenticated user or by providing refreshToken
    let userId = req.user?.id || req.user?._id;
    const refreshToken = typeof req.body?.refreshToken === 'string'
      ? req.body.refreshToken
      : typeof req.headers['x-refresh-token'] === 'string'
      ? req.headers['x-refresh-token']
      : null;

    if (!userId && refreshToken) {
      try {
        const decoded = verifyRefreshToken(String(refreshToken));
        userId = decoded.sub;
      } catch (err) {
        // ignore - will return unauthorized below
      }
    }

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized.' });
    }

    const result = await authServiceV2.logout(userId);

    res.json(result);
  } catch (error) {
    console.error('Logout error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Logout failed.',
    });
  }
}

// ============= REFRESH TOKEN =============
async function refreshToken(req, res, next) {
  try {
    const refreshToken = typeof req.body?.refreshToken === 'string'
      ? req.body.refreshToken
      : typeof req.headers['x-refresh-token'] === 'string'
      ? req.headers['x-refresh-token']
      : null;

    if (!refreshToken) {
      return res.status(401).json({ success: false, message: 'Refresh token missing.' });
    }

    // If request already carries an authenticated user, prefer that id
    let userId = req.user?.id || req.user?._id;

    // Otherwise try to verify the refresh token to extract the subject
    if (!userId) {
      try {
        const decoded = verifyRefreshToken(String(refreshToken));
        userId = decoded.sub;
      } catch (err) {
        return res.status(401).json({ success: false, message: 'Refresh token invalid or expired.' });
      }
    }

    const result = await authServiceV2.refreshAccessToken(userId, refreshToken);

    res.json({
      success: true,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
    });
  } catch (error) {
    console.error('Token refresh error:', error.message);
    res.status(401).json({
      success: false,
      message: error.message || 'Token refresh failed.',
    });
  }
}

module.exports = {
  register,
  login,
  forgotPassword,
  verifyOTPAndResetPassword,
  getVerificationStatus,
  logout,
  refreshToken,
  requestEmailVerificationOTP,
  verifyEmailOTPFromProfile,
};
