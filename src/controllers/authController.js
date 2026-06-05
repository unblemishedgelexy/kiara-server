const UserModel = require('../models/User');
const authService = require('../services/authService');
const { createOTP, verifyOTP, sendEmailOTP, sendSMSOTP } = require('../services/otpService');
const { generateAccessToken, generateRefreshToken, verifyAccessToken, verifyRefreshToken } = require('../services/tokenService');
const { env, isProductionEnv } = require('../config/env');

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

function buildAuthPayload(user, accessToken) {
  const safeUser = sanitizeUser(user);
  return {
    accessToken,
    token: accessToken,
    user: safeUser,
    data: {
      accessToken,
      user: safeUser,
    },
  };
}

function clearAuthCookies(res) {
  res.clearCookie('accessToken', buildCookieOptions(0));
  res.clearCookie('refreshToken', buildCookieOptions(0));
}

async function register(req, res, next) {
  try {
    const { firstName, lastName, email, mobileNumber, password } = req.body;
    const user = await authService.createUser({ firstName, lastName, email, password, mobileNumber });
    const emailOtp = await createOTP(user.email, 'email_verify', 300, { userId: user._id });
    const mobileOtp = await createOTP(user.mobileNumber, 'mobile_verify', 300, { userId: user._id });
    await sendEmailOTP(user.email, emailOtp.code);
    await sendSMSOTP(user.mobileNumber, mobileOtp.code);
    res.status(201).json({ success: true, message: 'Registration started. Verify email and mobile using OTPs.', data: { userId: user._id } });
  } catch (err) { next(err); }
}

async function verifyEmailOTP(req, res, next) {
  try {
    const { email, code } = req.body;
    const doc = await verifyOTP(email.toLowerCase(), code, 'email_verify');
    if (!doc) {
      return res.status(400).json({ success: false, message: 'Invalid or expired code' });
    }
    const user = await UserModel.findByIdAndUpdate(doc.meta.userId, { emailVerified: true }, { returnDocument: 'after' });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.json({ success: true, message: 'Email verified successfully', data: { emailVerified: user.emailVerified } });
  } catch (err) { next(err); }
}

async function verifyMobileOTP(req, res, next) {
  try {
    const { mobileNumber, code } = req.body;
    const doc = await verifyOTP(mobileNumber, code, 'mobile_verify');
    if (!doc) {
      return res.status(400).json({ success: false, message: 'Invalid or expired code' });
    }
    const user = await UserModel.findByIdAndUpdate(doc.meta.userId, { mobileVerified: true }, { returnDocument: 'after' });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.json({ success: true, message: 'Mobile verified successfully', data: { mobileVerified: user.mobileVerified } });
  } catch (err) { next(err); }
}

function sanitizeUser(user) {
  if (!user) return null;
  const {
    _id,
    firstName,
    lastName,
    email,
    emailVerified,
    mobileNumber,
    mobileVerified,
    profilePicture,
    googleId,
    role,
  } = user;
  return {
    id: String(_id),
    firstName,
    lastName,
    email,
    emailVerified,
    mobileNumber,
    mobileVerified,
    profilePicture,
    googleId,
    role,
  };
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const { user, accessToken, refreshToken } = await authService.loginWithEmail(email, password);
    setAuthCookies(res, accessToken, refreshToken);
    res.json({ success: true, message: 'Logged in successfully', ...buildAuthPayload(user, accessToken) });
  } catch (err) { next(err); }
}

async function guestSession(req, res, next) {
  try {
    const accessTokenCookie = req.cookies?.accessToken;
    if (accessTokenCookie) {
      try {
        const decoded = verifyAccessToken(accessTokenCookie);
        const existingUser = await UserModel.findById(decoded.sub);

        if (existingUser) {
          return res.json({
            success: true,
            message: 'Session already active',
            ...buildAuthPayload(existingUser, accessTokenCookie),
          });
        }
      } catch {
        // Try refresh token before creating a guest session.
      }
    }

    const refreshTokenCookie = req.cookies?.refreshToken;
    if (refreshTokenCookie) {
      try {
        const decoded = verifyRefreshToken(refreshTokenCookie);
        const result = await authService.refreshSession(
          decoded.sub,
          refreshTokenCookie,
          req.headers['user-agent'],
          req.ip
        );
        const existingUser = await UserModel.findById(decoded.sub);

        if (existingUser) {
          setAuthCookies(res, result.accessToken, result.refreshToken);
          return res.json({
            success: true,
            message: 'Session refreshed',
            ...buildAuthPayload(existingUser, result.accessToken),
          });
        }
      } catch {
        // Fall through and create a new guest session.
      }
    }

    const user = await authService.ensureGuestUser();
    const accessToken = generateAccessToken({ sub: user._id });
    const refreshToken = generateRefreshToken({ sub: user._id });
    await authService.createSession(user._id, refreshToken);
    setAuthCookies(res, accessToken, refreshToken);
    res.status(201).json({ success: true, message: 'Guest session created', ...buildAuthPayload(user, accessToken) });
  } catch (err) { next(err); }
}

async function googleLogin(req, res, next) {
  try {
    const { idToken, mobileNumber } = req.body;
    const result = await authService.loginWithGoogleToken(idToken, mobileNumber);
    if (result.pendingMobileVerification) {
      if (mobileNumber) {
        const otp = await createOTP(mobileNumber, 'mobile_verify', 300, { userId: result.user._id });
        await sendSMSOTP(mobileNumber, otp.code);
      }
      return res.json({ success: true, message: 'Mobile verification required', data: { user: result.user, pendingMobileVerification: true } });
    }
    setAuthCookies(res, result.accessToken, result.refreshToken);
    res.json({ success: true, message: 'Logged in with Google successfully', ...buildAuthPayload(result.user, result.accessToken) });
  } catch (err) { next(err); }
}

async function refreshToken(req, res, next) {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) {
      return res.status(401).json({ success: false, message: 'Refresh token missing' });
    }
    const decoded = verifyRefreshToken(refreshToken);
    const result = await authService.refreshSession(decoded.sub, refreshToken, req.headers['user-agent'], req.ip);
    setAuthCookies(res, result.accessToken, result.refreshToken);
    res.json({
      success: true,
      message: 'Token refreshed',
      accessToken: result.accessToken,
      token: result.accessToken,
      data: { accessToken: result.accessToken },
    });
  } catch (err) { next(err); }
}

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

module.exports = { register, verifyEmailOTP, verifyMobileOTP, login, googleLogin, refreshToken, logout, guestSession };

