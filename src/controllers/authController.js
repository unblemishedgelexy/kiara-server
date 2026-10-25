const authService = require('../services/../services/auth/authService');
const { verifyRefreshToken } = require('../services/../services/auth/tokenService');
const { generateAccessToken, generateRefreshToken } = require('../services/../services/auth/tokenService');
const UserModel = require('../models/User');
const bcrypt = require('bcryptjs');
const googleOAuthService = require('../services/../services/auth/googleOAuthService');
const { hasAdminPanelAccess } = require('../middleware/requireAdmin');


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

async function createLocalDevelopmentSession(req, res) {
  const { env } = require('../config/env');
  if (!env.localDevAuthEnabled) {
    return res.status(404).json({ success: false, message: 'Not found.' });
  }

  const email = 'kiara.local.test@gmail.com';
  let user = await UserModel.findOne({ email });
  if (!user) {
    user = await UserModel.create({
      email,
      firstName: 'Local',
      lastName: 'Test User',
      displayName: 'Local Test User',
      passwordHash: await bcrypt.hash(`local-${Date.now()}-${Math.random()}`, 12),
      emailVerified: true,
      mode: 'registered',
      isActive: true,
    });
  }

  const accessToken = generateAccessToken({ sub: user._id });
  const refreshToken = generateRefreshToken({ sub: user._id });
  await authService.createSession(user._id, refreshToken, {
    userAgent: req.headers['user-agent'],
    ip: req.ip,
  });

  return res.json({
    success: true,
    message: 'Local development session created.',
    ...buildAuthPayload(user, accessToken, refreshToken),
  });
}

// ============= REGISTRATION =============
async function register(req, res, next) {
  try {
    const {
      firstName,
      lastName,
      email,
      password,
      mobileNumber,
    } = req.body;
    
    // Register user
    const result = await authService.registerUser({
      firstName,
      lastName,
      email,
      password,
      mobileNumber,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    
    res.status(202).json({
      success: true,
      message: result.message,
      user: result.user,
      verificationRequired: true,
    });
  } catch (error) {
    const statusCode = error.code === 'OTP_RATE_LIMITED' ? 429
      : error.code === 'OTP_DELIVERY_FAILED' || error.code === 'REDIS_UNAVAILABLE' ? 503
        : error.message.includes('already') || error.message.includes('Only ') || error.message.includes('required') ? 400
          : 503;
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
    await authService.generateAndSendOTP(email, type, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    
    res.json({
      success: true,
      message: `OTP sent to ${email}. Valid for 10 minutes.`,
    });
  } catch (error) {
    const statusCode = error.code === 'OTP_RATE_LIMITED' ? 429
      : error.code === 'OTP_DELIVERY_FAILED' || error.code === 'REDIS_UNAVAILABLE' ? 503
        : error.message.includes('allowed') || error.message.includes('pending') || error.message.includes('Unsupported')
          ? 400
          : 503;
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

async function getGoogleAuthUrl(req, res, next) {
  try {
    const redirectUri = typeof req.query?.redirectUri === 'string' ? req.query.redirectUri.trim() : '';
    if (!redirectUri) {
      return res.status(400).json({ success: false, message: 'redirectUri is required.' });
    }

    const result = await googleOAuthService.createAuthRequest(redirectUri);
    res.json({ success: true, authUrl: result.authUrl, data: { authUrl: result.authUrl } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message || 'Unable to create Google auth URL.' });
  }
}

async function handleGoogleCallback(req, res, next) {
  let returnUrl;
  try {
    const { code, state, error } = req.query;
    if (!state) return res.status(400).json({ success: false, message: 'Missing OAuth state.' });
    const authState = await googleOAuthService.consumeAuthState(String(state));
    if (!authState) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OAuth state.' });
    }
    returnUrl = new URL(authState.returnUrl);
    if (error) {
      returnUrl.searchParams.set('status', 'denied');
      returnUrl.searchParams.set('message', 'Google sign-in was cancelled.');
      return res.redirect(303, returnUrl.toString());
    }
    if (!code) {
      returnUrl.searchParams.set('status', 'error');
      returnUrl.searchParams.set('message', 'Google did not return an authorization code.');
      return res.redirect(303, returnUrl.toString());
    }

    const tokenPayload = await googleOAuthService.exchangeCodeForTokens(String(code), authState.codeVerifier);
    const idTokenPayload = await googleOAuthService.verifyIdToken(tokenPayload.id_token);

    const googleUser = {
      googleId: idTokenPayload.sub,
      email: idTokenPayload.email,
      firstName: idTokenPayload.given_name,
      lastName: idTokenPayload.family_name,
      profilePicture: idTokenPayload.picture,
      googleEmail: idTokenPayload.email,
    };

    const normalizedEmail = googleUser.email.toLowerCase();
    const [emailAccount, linkedGoogleAccount] = await Promise.all([
      UserModel.findOne({ email: normalizedEmail }).select('googleId role isActive').lean(),
      UserModel.findOne({ googleId: googleUser.googleId }).select('email').lean(),
    ]);
    const googleIdMismatch = emailAccount?.googleId && emailAccount.googleId !== googleUser.googleId;
    const emailMismatch = linkedGoogleAccount && linkedGoogleAccount.email.toLowerCase() !== normalizedEmail;
    if (!hasAdminPanelAccess(emailAccount) || googleIdMismatch || emailMismatch) {
      returnUrl.searchParams.set('status', 'denied');
      returnUrl.searchParams.set('message', 'This Google account is not assigned an active admin or developer role.');
      return res.redirect(303, returnUrl.toString());
    }

    const result = await authService.loginWithGoogle(googleUser);
    
    const authTicket = await googleOAuthService.createAuthTicket(
      result.user._id || result.user.id,
      result.accessToken,
      result.refreshToken
    );
    returnUrl.searchParams.set('auth_ticket', authTicket);
    returnUrl.searchParams.set('status', 'success');

    return res.redirect(303, returnUrl.toString());
  } catch (error) {
    console.error('[authController] Google callback failed:', error?.name || 'OAuthCallbackError', error?.code || 'UNKNOWN');
    if (returnUrl) {
      returnUrl.searchParams.set('status', 'error');
      returnUrl.searchParams.set('message', 'Google sign-in could not be completed. Please try again.');
      return res.redirect(303, returnUrl.toString());
    }
    return res.status(500).json({ success: false, message: 'Google authentication failed.' });
  }
}

async function acceptLegalConsent(req, res) {
  try {
    const user = await authService.acceptLegalConsent(req.userId);
    return res.json({
      success: true,
      data: { user },
    });
  } catch (error) {
    const notFound = error?.code === 'USER_NOT_FOUND';
    return res.status(notFound ? 404 : 500).json({
      success: false,
      message: notFound ? 'User not found.' : 'Unable to save legal consent.',
    });
  }
}

// ============= TICKET EXCHANGE =============
async function exchangeAuthTicket(req, res, next) {
  try {
    const authTicket = typeof req.body?.authTicket === 'string' ? req.body.authTicket : null;
    if (!authTicket) {
      return res.status(400).json({ success: false, message: 'authTicket is required.' });
    }

    const ticket = await googleOAuthService.consumeAuthTicket(authTicket);
    if (!ticket) {
      return res.status(400).json({ success: false, message: 'Invalid or expired auth ticket.' });
    }

    const user = await authService.findUserById(ticket.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    return res.json({
      success: true,
      message: 'Auth ticket exchanged successfully.',
      user: authService.sanitizeUser(user),
      accessToken: ticket.accessToken,
      refreshToken: ticket.refreshToken,
      data: {
        user: authService.sanitizeUser(user),
        accessToken: ticket.accessToken,
        refreshToken: ticket.refreshToken,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to exchange auth ticket.' });
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
  } catch (err) {
    const message = err && err.message ? err.message : 'Token refresh failed.';
    const statusCode =
      (err && err.name === 'TokenExpiredError') ||
      (err && err.name === 'JsonWebTokenError') ||
      /refresh token invalid|expired/i.test(message)
        ? 401
        : 400;

    console.error('[AUTH_REFRESH_FAILED]', err?.name || 'TokenRefreshError', statusCode);

    return res.status(statusCode).json({
      success: false,
      message,
      code: 'REFRESH_FAILED',
      requestId: req?.requestId,
    });
  }
}

// ============= LOGOUT =============
async function logout(req, res, next) {
  try {
    const bodyRefreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : null;
    const headerRefreshToken = typeof req.headers['x-refresh-token'] === 'string' ? req.headers['x-refresh-token'] : null;
    const refreshToken = bodyRefreshToken || headerRefreshToken;

    if (refreshToken) {
      try {
        const decoded = verifyRefreshToken(refreshToken);
        await authService.logout(decoded.sub, refreshToken);
      } catch (error) {
        console.warn('[authController] logout token rejected:', error?.name || 'TokenVerificationError');
      }
    }

    res.json({ success: true, message: 'Logged out successfully.' });
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
    await authService.sendForgotPasswordOTP(email, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    
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

async function resetPasswordHandler(req, res, next) {
  try {
    const { email, code, newPassword, confirmPassword } = req.body;
    
    if (!email || !code || !newPassword || !confirmPassword) {
      return res.status(400).json({ success: false, message: 'Email, OTP, password, and confirmation are required.' });
    }
    
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'Passwords do not match.' });
    }
    
    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters long.' });
    }
    
    // Reset password
    await authService.resetPasswordWithOtp(email, code, newPassword);
    
    res.json({
      success: true,
      message: 'Password reset successfully. You can now login with your new password.',
    });
  } catch (error) {
    return res.status(error.message.includes('Invalid or expired OTP') ? 400 : 503).json({
      success: false,
      message: error.message || 'Password reset failed.',
    });
  }
}

module.exports = { 
  createLocalDevelopmentSession,
  register, 
  acceptLegalConsent,
  sendOtp, 
  verifyOtp, 
  login, 
  getGoogleAuthUrl, 
  handleGoogleCallback, 
  exchangeAuthTicket,
  refreshToken, 
  logout, 
  sendForgotPasswordOtp, 
  resetPasswordHandler, 
};
