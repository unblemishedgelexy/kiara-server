const authService = require('../services/authService');
const UserModel = require('../models/User');
const { verifyAccessToken, verifyRefreshToken, generateAccessToken, generateRefreshToken } = require('../services/tokenService');
const { env, isProductionEnv } = require('../config/env');
const { extractBearerToken } = require('../utils/authCookies');

function buildCookieOptions(maxAge) {
  const options = {
    httpOnly: true,
    secure: isProductionEnv(),
    sameSite: isProductionEnv() ? 'none' : 'lax',
    maxAge,
  };
  if (env.cookieDomain) {
    options.domain = env.cookieDomain;
  }
  return options;
}

function setAuthCookies(res, accessToken, refreshToken) {
  res.cookie('accessToken', accessToken, buildCookieOptions(15 * 60 * 1000));
  res.cookie('refreshToken', refreshToken, buildCookieOptions(30 * 24 * 60 * 60 * 1000));
}

function clearAuthCookies(res) {
  res.clearCookie('accessToken', buildCookieOptions(0));
  res.clearCookie('refreshToken', buildCookieOptions(0));
}

function buildAuthPayload(user, accessToken, refreshToken) {
  const safeUser = authService.sanitizeUser(user);
  return {
    accessToken,
    refreshToken,
    token: accessToken,
    user: safeUser,
    data: {
      accessToken,
      refreshToken,
      user: safeUser,
    },
  };
}

// ============= REGISTRATION =============
async function register(req, res, next) {
  try {
    const { firstName, lastName, email, password, mobileNumber } = req.body;
    
    // Register user
    const result = await authService.registerUser({
      firstName,
      lastName,
      email,
      password,
      mobileNumber,
    });
    
    res.status(201).json({
      success: true,
      message: result.message,
      user: result.user,
      otpSent: result.otpSent,
    });
  } catch (error) {
    const statusCode = error.message.includes('already') ? 400 : 400;
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Registration failed.',
    });
  }
}

// ============= OTP HANDLERS =============
async function sendOtp(req, res, next) {
  try {
    const { email, type = 'REGISTER_EMAIL' } = req.body;
    
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required.' });
    }
    
    // Send OTP
    await authService.generateAndSendOTP(email, type);
    
    res.json({
      success: true,
      message: `OTP sent to ${email}. Valid for 10 minutes.`,
    });
  } catch (error) {
    const statusCode = error.message.includes('allowed') ? 400 : 500;
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to send OTP.',
    });
  }
}

async function verifyOtp(req, res, next) {
  try {
    const { email, code, type = 'REGISTER_EMAIL' } = req.body;
    
    if (!email || !code) {
      return res.status(400).json({ success: false, message: 'Email and OTP code are required.' });
    }
    
    // Verify OTP
    await authService.verifyOTP(email, code, type);
    
    res.json({
      success: true,
      message: 'OTP verified successfully. You can now login.',
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || 'OTP verification failed.',
    });
  }
}

// ============= LOGIN =============
async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }
    
    // Login with email and password
    const result = await authService.loginWithEmailPassword(email, password);
    
    // Set secure HttpOnly cookies
    setAuthCookies(res, result.accessToken, result.refreshToken);
    
    // Return success response
    res.json({
      success: true,
      message: 'Logged in successfully.',
      ...buildAuthPayload(result.user, result.accessToken, result.refreshToken),
    });
  } catch (error) {
    const statusCode = error.message.includes('Invalid') || error.message.includes('password') ? 401 : 400;
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Login failed.',
    });
  }
}

// ============= TOKEN REFRESH =============
async function refreshToken(req, res, next) {
  try {
    const bodyRefreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : null;
    const headerRefreshToken = typeof req.headers['x-refresh-token'] === 'string'
      ? req.headers['x-refresh-token']
      : null;
    const refreshToken = req.cookies?.refreshToken || bodyRefreshToken || headerRefreshToken;

    if (!refreshToken) {
      const accessToken = req.cookies?.accessToken || extractBearerToken(req.headers.authorization || '');

      if (accessToken) {
        try {
          verifyAccessToken(accessToken);
          return res.json({
            success: true,
            message: 'Access token still active',
            accessToken,
            token: accessToken,
            data: { accessToken },
          });
        } catch {
          // Fall through to missing refresh response.
        }
      }

      return res.status(401).json({ success: false, message: 'Refresh token missing' });
    }

    const decoded = verifyRefreshToken(refreshToken);
    const result = await authService.refreshSession(decoded.sub, refreshToken, req.headers['user-agent'], req.ip);
    setAuthCookies(res, result.accessToken, result.refreshToken);
    res.json({
      success: true,
      message: 'Token refreshed',
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      token: result.accessToken,
      data: {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      },
    });
  } catch (err) { next(err); }
}

// ============= LOGOUT =============
async function logout(req, res, next) {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (refreshToken) {
      const decoded = verifyRefreshToken(refreshToken);
      await authService.logout(decoded.sub, refreshToken);
    }
    clearAuthCookies(res);
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    clearAuthCookies(res);
    next(err);
  }
}

// ============= FORGOT PASSWORD =============
async function sendForgotPasswordOtp(req, res, next) {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required.' });
    }
    
    // Send OTP
    await authService.sendForgotPasswordOTP(email);
    
    res.json({
      success: true,
      message: `Password reset link sent to ${email}. Check your email for OTP.`,
    });
  } catch (error) {
    const statusCode = error.message.includes('allowed') ? 400 : 500;
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to send reset OTP.',
    });
  }
}

async function verifyForgotPasswordOtp(req, res, next) {
  try {
    const { email, code } = req.body;
    
    if (!email || !code) {
      return res.status(400).json({ success: false, message: 'Email and OTP code are required.' });
    }
    
    // Verify OTP
    await authService.verifyForgotPasswordOTP(email, code);
    
    res.json({
      success: true,
      message: 'OTP verified. You can now reset your password.',
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || 'OTP verification failed.',
    });
  }
}

async function resetPasswordHandler(req, res, next) {
  try {
    const { email, newPassword, confirmPassword } = req.body;
    
    if (!email || !newPassword || !confirmPassword) {
      return res.status(400).json({ success: false, message: 'Email, password, and confirmation are required.' });
    }
    
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'Passwords do not match.' });
    }
    
    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters long.' });
    }
    
    // Reset password
    await authService.resetPassword(email, newPassword);
    
    res.json({
      success: true,
      message: 'Password reset successfully. You can now login with your new password.',
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || 'Password reset failed.',
    });
  }
}

// ============= GOOGLE OAUTH =============
async function googleAuthCallback(req, res) {
  try {
    if (!req.user) {
      // If request expects JSON, return an error JSON instead of redirecting
      const clientUrl = env.clientOrigins[0] || 'http://localhost:5173';
      if ((req.headers.accept || '').includes('application/json') || req.query.returnJson === '1') {
        return res.status(400).json({ success: false, message: 'Google authentication failed' });
      }
      return res.redirect(`${clientUrl}/login?error=google_auth_failed`);
    }

    // Get user info from Google passport strategy
    const { id: googleId, displayName, emails, photos } = req.user;
    const email = emails?.[0]?.value || '';
    const profilePicture = photos?.[0]?.value || '';
    const [firstName, lastName] = displayName ? displayName.split(' ') : ['', ''];

    // Login or register with Google
    const result = await authService.loginWithGoogle({
      googleId,
      email,
      firstName,
      lastName,
      profilePicture,
      googleEmail: email,
    });

    // Set cookies
    setAuthCookies(res, result.accessToken, result.refreshToken);

    // If the caller expects JSON (fetch from frontend), respond with JSON payload
    const wantsJson = (req.headers.accept || '').includes('application/json') || req.query.returnJson === '1';
    if (wantsJson) {
      return res.json({
        success: true,
        message: result.message || 'Logged in with Google',
        ...buildAuthPayload(result.user, result.accessToken, result.refreshToken),
      });
    }

    // Otherwise redirect to frontend home page with auth set in cookies
    const clientUrl = env.clientOrigins[0] || 'http://localhost:5173';
    res.redirect(`${clientUrl}/`);
  } catch (error) {
    console.error('Google callback error:', error);
    const clientUrl = env.clientOrigins[0] || 'http://localhost:5173';
    if ((req.headers.accept || '').includes('application/json') || req.query.returnJson === '1') {
      return res.status(500).json({ success: false, message: error.message || 'Google callback error' });
    }
    res.redirect(`${clientUrl}/login?error=${encodeURIComponent(error.message)}`);
  }
}

// Guest sessions removed — functionality intentionally disabled.

module.exports = { register, sendOtp, verifyOtp, login, refreshToken, logout, sendForgotPasswordOtp, verifyForgotPasswordOtp, resetPasswordHandler, googleAuthCallback };
