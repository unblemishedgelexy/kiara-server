const authService = require('../services/authService');
const { verifyRefreshToken } = require('../services/tokenService');
const googleOAuthService = require('../services/googleOAuthService');


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
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
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

async function getGoogleAuthUrl(req, res, next) {
  try {
    const redirectUri = typeof req.query?.redirectUri === 'string' ? req.query.redirectUri.trim() : '';
    if (!redirectUri) {
      return res.status(400).json({ success: false, message: 'redirectUri is required.' });
    }

    const result = await googleOAuthService.createAuthRequest(redirectUri);
    res.json({ success: true, authUrl: result.authUrl });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message || 'Unable to create Google auth URL.' });
  }
}

async function handleGoogleCallback(req, res, next) {
  try {
    const { code, state, error, error_description: errorDescription } = req.query;

    if (error) {
      const message = typeof errorDescription === 'string' ? errorDescription : 'Google authentication was cancelled or denied.';
      return res.status(400).json({ success: false, message });
    }

    if (!code || !state) {
      return res.status(400).json({ success: false, message: 'Missing code or state in callback response.' });
    }

    const authState = await googleOAuthService.consumeAuthState(String(state));
    if (!authState) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OAuth state.' });
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

    const result = await authService.loginWithGoogle(googleUser);
    const authTicket = await googleOAuthService.createAuthTicket(
      result.user._id || result.user.id,
      result.accessToken,
      result.refreshToken
    );

    const redirectUrl = new URL(authState.returnUrl);
    redirectUrl.searchParams.set('auth_ticket', authTicket);
    redirectUrl.searchParams.set('status', 'success');

    return res.redirect(303, redirectUrl.toString());
  } catch (error) {
    console.error('[authController] Google callback error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Google callback failed.' });
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
  } catch (err) { next(err); }
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
        console.log(`[authController] logout request for user ${decoded.sub}`);
        await authService.logout(decoded.sub, refreshToken);
      } catch (error) {
        console.warn('[authController] logout failed to verify refresh token:', error.message || error);
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

module.exports = { 
  register, 
  sendOtp, 
  verifyOtp, 
  login, 
  getGoogleAuthUrl, 
  handleGoogleCallback, 
  exchangeAuthTicket,
  refreshToken, 
  logout, 
  sendForgotPasswordOtp, 
  verifyForgotPasswordOtp, 
  resetPasswordHandler, 
};
