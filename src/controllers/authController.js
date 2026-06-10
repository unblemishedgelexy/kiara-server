const authService = require('../services/authService');
const UserModel = require('../models/User');
const { verifyAccessToken, verifyRefreshToken, generateAccessToken, generateRefreshToken } = require('../services/tokenService');
const { env, isProductionEnv } = require('../config/env');
const { extractBearerToken } = require('../utils/authCookies');
const { OAuth2Client } = require('google-auth-library');


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
    const refreshToken = bodyRefreshToken || headerRefreshToken;

    if (!refreshToken) {
      return res.status(401).json({ success: false, message: 'Refresh token missing' });
    }

    const decoded = verifyRefreshToken(refreshToken);
    const result = await authService.refreshSession(decoded.sub, refreshToken, req.headers['user-agent'], req.ip);
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
    res.json({ success: true, message: 'Logout is disabled; session preserved.' });
  } catch (err) {
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

    const wantsJson = (req.headers.accept || '').includes('application/json') || req.query.returnJson === '1';
    if (wantsJson) {
      return res.json({
        success: true,
        message: result.message || 'Logged in with Google',
        ...buildAuthPayload(result.user, result.accessToken, result.refreshToken),
      });
    }

    if (!result.accessToken || !result.refreshToken) {
      throw new Error('Google login did not generate valid authentication tokens.');
    }

    // Try to read client information from OAuth state (preferred), fallback to query param
    let clientRequestType = null;
    if (req.query && req.query.state) {
      try {
        const decoded = Buffer.from(String(req.query.state), 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        clientRequestType = parsed?.client || parsed?.clientType || null;
      } catch (e) {
        console.warn('[authController] Failed to parse OAuth state', e);
      }
    }

    if (!clientRequestType) {
      clientRequestType = Array.isArray(req.query.client) ? req.query.client[0] : req.query.client;
    }

    const useNativeRedirect = clientRequestType === 'capacitor' || clientRequestType === 'mobile';
    const clientUrl = useNativeRedirect ? env.nativeClientRedirectUrl : env.clientOrigins[0] || 'http://localhost:5173';
    const redirectUrl = `${clientUrl}/auth/google/callback?accessToken=${encodeURIComponent(result.accessToken)}&refreshToken=${encodeURIComponent(result.refreshToken)}`;
    const redirectPath = `${clientUrl}/auth/google/callback`;

    console.debug('[authController] Redirecting Google callback', {
      clientRequestType,
      clientUrl,
      redirectPath,
      accessToken: !!result.accessToken,
      refreshToken: !!result.refreshToken,
    });

    res.redirect(redirectUrl);
  } catch (error) {
    console.error('Google callback error:', error);
    const clientUrl = env.clientOrigins[0] || 'http://localhost:5173';
    if ((req.headers.accept || '').includes('application/json') || req.query.returnJson === '1') {
      return res.status(500).json({ success: false, message: error.message || 'Google callback error' });
    }
    res.redirect(`${clientUrl}/login?error=${encodeURIComponent(error.message)}`);
  }
}

// ============= NATIVE GOOGLE SIGN-IN (Mobile) =============
async function googleSignInHandler(req, res, next) {
  try {
    const { idToken, serverAuthCode } = req.body;

    if (!idToken) {
      return res.status(400).json({ success: false, message: 'ID token is required.' });
    }

    // Verify ID token with Google
    const client = new OAuth2Client(env.googleClientId);
    let ticket;
    
    try {
      ticket = await client.verifyIdToken({
        idToken,
        audience: env.googleClientId,
      });
    } catch (error) {
      console.error('[authController] Google token verification failed:', error.message);
      return res.status(401).json({ 
        success: false, 
        message: 'Google authentication failed. Invalid or expired token.' 
      });
    }

    const payload = ticket.getPayload();
    
    if (!payload) {
      return res.status(401).json({ success: false, message: 'Failed to extract Google profile data.' });
    }

    // Extract user info from Google token
    const googleId = payload.sub;
    const email = payload.email;
    const firstName = payload.given_name || '';
    const lastName = payload.family_name || '';
    const profilePicture = payload.picture || '';

    if (!email) {
      return res.status(400).json({ success: false, message: 'Email not found in Google profile.' });
    }

    console.debug('[authController] Google sign-in verified', { email, googleId });

    // Login or register with Google
    const result = await authService.loginWithGoogle({
      googleId,
      email,
      firstName,
      lastName,
      profilePicture,
      googleEmail: email,
    });

    if (!result.accessToken || !result.refreshToken) {
      throw new Error('Failed to generate authentication tokens.');
    }

    console.debug('[authController] Google sign-in successful', { email, isNewUser: !result.existingUser });

    res.json({
      success: true,
      message: result.message || 'Logged in with Google successfully.',
      ...buildAuthPayload(result.user, result.accessToken, result.refreshToken),
    });
  } catch (error) {
    console.error('[authController] Google sign-in handler error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Google sign-in failed.',
    });
  }
}

module.exports = { 
  register, 
  sendOtp, 
  verifyOtp, 
  login, 
  refreshToken, 
  logout, 
  sendForgotPasswordOtp, 
  verifyForgotPasswordOtp, 
  resetPasswordHandler, 
  googleSignInHandler,
};
