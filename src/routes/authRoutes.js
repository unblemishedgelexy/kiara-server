const express = require('express');
const Joi = require('joi');
const validateRequest = require('../middleware/validateRequest');
const authMiddleware = require('../middleware/authMiddleware');
const { env } = require('../config/env');
const authController = require('../controllers/authController');

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

// Authentication endpoints - all using standard authController
router.post('/register', validateRequest(registerSchema), authController.register);
router.post('/login', validateRequest(loginSchema), authController.login);
router.get('/google/url', validateRequest(Joi.object({ query: Joi.object({ redirectUri: Joi.string().required() }).unknown(true) })), authController.getGoogleAuthUrl);
router.get('/google/callback', authController.handleGoogleCallback);
router.post('/send-otp', validateRequest(sendOtpSchema), authController.sendOtp);
router.post('/verify-otp', validateRequest(verifyOtpSchema), authController.verifyOtp);

// Forgot Password endpoints
router.post('/forgot-password/send-otp', validateRequest(forgotPasswordSendSchema), authController.sendForgotPasswordOtp);
router.post('/forgot-password/verify-otp', validateRequest(forgotPasswordVerifySchema), authController.verifyForgotPasswordOtp);
router.post('/forgot-password/reset', validateRequest(resetPasswordSchema), authController.resetPasswordHandler);

// Token management
router.post('/auth-ticket', authController.exchangeAuthTicket);
router.post('/refresh-token', authController.refreshToken);
router.post('/logout', authController.logout);

module.exports = router;

