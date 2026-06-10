const express = require('express');
const Joi = require('joi');
const validateRequest = require('../middleware/validateRequest');
const authMiddleware = require('../middleware/authMiddleware');
const { env } = require('../config/env');
const { register, sendOtp, verifyOtp, login, refreshToken, logout, sendForgotPasswordOtp, verifyForgotPasswordOtp, resetPasswordHandler, googleAuthCallback } = require('../controllers/authController');
const passport = require('passport');

const router = express.Router();

// PRODUCTION RULES:
// - Email/password authentication with @gmail.com only
// - OTP-based email verification
// - Password-based login
// - Google OAuth supported
// - No SMS OTP
// - Forgot password via email OTP

// Registration Schema
const registerSchema = Joi.object({
  body: Joi.object({
    firstName: Joi.string().required().trim(),
    lastName: Joi.string().required().trim(),
    email: Joi.string().email().required().lowercase(),
    password: Joi.string().min(8).required(),
    mobileNumber: Joi.string().optional().trim(),
  }),
});

// Login Schema
const loginSchema = Joi.object({
  body: Joi.object({
    email: Joi.string().email().required().lowercase(),
    password: Joi.string().required(),
  }),
});

// Send OTP Schema
const sendOtpSchema = Joi.object({
  body: Joi.object({
    email: Joi.string().email().required().lowercase(),
    type: Joi.string().valid('REGISTER_EMAIL', 'REGISTER_MOBILE', 'FORGOT_PASSWORD_EMAIL', 'FORGOT_PASSWORD_MOBILE', 'CHANGE_EMAIL', 'CHANGE_MOBILE').default('REGISTER_EMAIL'),
  }),
});

// Verify OTP Schema
const verifyOtpSchema = Joi.object({
  body: Joi.object({
    email: Joi.string().email().required().lowercase(),
    code: Joi.string().length(6).required(),
    type: Joi.string().valid('REGISTER_EMAIL', 'REGISTER_MOBILE', 'FORGOT_PASSWORD_EMAIL', 'FORGOT_PASSWORD_MOBILE', 'CHANGE_EMAIL', 'CHANGE_MOBILE').default('REGISTER_EMAIL'),
  }),
});

// Forgot Password Schema - Send OTP
const forgotPasswordSendSchema = Joi.object({
  body: Joi.object({
    email: Joi.string().email().required().lowercase(),
  }),
});

// Forgot Password Schema - Verify OTP
const forgotPasswordVerifySchema = Joi.object({
  body: Joi.object({
    email: Joi.string().email().required().lowercase(),
    code: Joi.string().length(6).required(),
  }),
});

// Forgot Password Schema - Reset Password
const resetPasswordSchema = Joi.object({
  body: Joi.object({
    email: Joi.string().email().required().lowercase(),
    newPassword: Joi.string().min(8).required(),
    confirmPassword: Joi.string().required(),
  }),
});

// Authentication endpoints
router.post('/register', validateRequest(registerSchema), register);
router.post('/login', validateRequest(loginSchema), login);
router.post('/send-otp', validateRequest(sendOtpSchema), sendOtp);
router.post('/verify-otp', validateRequest(verifyOtpSchema), verifyOtp);

// Forgot Password endpoints
router.post('/forgot-password/send-otp', validateRequest(forgotPasswordSendSchema), sendForgotPasswordOtp);
router.post('/forgot-password/verify-otp', validateRequest(forgotPasswordVerifySchema), verifyForgotPasswordOtp);
router.post('/forgot-password/reset', validateRequest(resetPasswordSchema), resetPasswordHandler);

// Token management
router.post('/refresh-token', refreshToken);
router.post('/logout', logout);
// Guest session for anonymous backend access (used by frontend for live tokens)
// NOTE: guest sessions removed — no /guest route

// Google OAuth routes
router.get('/google', (req, res, next) => {
  // Preserve client information across OAuth round-trip using state and callbackURL
  try {
    const client = req.query.client || req.query.clientType || null;
    const stateObj = { client };
    const state = Buffer.from(JSON.stringify(stateObj)).toString('base64');
    const callbackURL = client
      ? `${env.serverUrl}/auth/google/callback?client=${encodeURIComponent(String(client))}`
      : undefined;

    return passport.authenticate('google', {
      scope: ['profile', 'email'],
      session: false,
      state,
      ...(callbackURL ? { callbackURL } : {}),
    })(req, res, next);
  } catch (e) {
    return passport.authenticate('google', { scope: ['profile', 'email'], session: false })(req, res, next);
  }
});

router.get('/google/callback', 
  passport.authenticate('google', { session: false }),
  googleAuthCallback
);

module.exports = router;

