const express = require('express');
const Joi = require('joi');
const validateRequest = require('../middleware/validateRequest');
const authMiddleware = require('../middleware/authMiddleware');
const authController = require('../controllers/authController');

const router = express.Router();

const gmailEmailSchema = Joi.string()
  .trim()
  .email()
  .lowercase()
  .pattern(/^[^@\s]+@gmail\.com$/)
  .messages({
    'string.pattern.base': 'Only @gmail.com email accounts are allowed.',
  });

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
    email: gmailEmailSchema.required(),
    password: Joi.string().min(8).required(),
    mobileNumber: Joi.string().optional().trim(),
  }),
});

// Login Schema
const loginSchema = Joi.object({
  body: Joi.object({
    email: gmailEmailSchema.required(),
    password: Joi.string().required(),
  }),
});

// Send OTP Schema
const sendOtpSchema = Joi.object({
  body: Joi.object({
    email: gmailEmailSchema.required(),
    type: Joi.string().valid('REGISTER_EMAIL').default('REGISTER_EMAIL'),
  }),
});

// Verify OTP Schema
const verifyOtpSchema = Joi.object({
  body: Joi.object({
    email: gmailEmailSchema.required(),
    code: Joi.string().pattern(/^\d{6}$/).required(),
    type: Joi.string().valid('REGISTER_EMAIL').default('REGISTER_EMAIL'),
  }),
});

// Forgot Password Schema - Send OTP
const forgotPasswordSendSchema = Joi.object({
  body: Joi.object({
    email: gmailEmailSchema.required(),
  }),
});

// Forgot Password Schema - Reset Password
const resetPasswordSchema = Joi.object({
  body: Joi.object({
    email: gmailEmailSchema.required(),
    code: Joi.string().pattern(/^\d{6}$/).required(),
    newPassword: Joi.string().min(8).required(),
    confirmPassword: Joi.string().required(),
  }),
});

const legalConsentSchema = Joi.object({
  body: Joi.object({
    accepted: Joi.boolean().valid(true).required(),
  }),
});

// Authentication endpoints - all using standard authController
router.post('/register', validateRequest(registerSchema), authController.register);
router.post('/legal-consent', validateRequest(legalConsentSchema), authMiddleware, authController.acceptLegalConsent);
router.post('/login', validateRequest(loginSchema), authController.login);
router.post('/dev-session', authController.createLocalDevelopmentSession);
router.get('/google/url', validateRequest(Joi.object({
  query: Joi.object({
    redirectUri: Joi.string().required(),
    purpose: Joi.string().valid('admin', 'user').default('admin'),
  }).unknown(true),
})), authController.getGoogleAuthUrl);
router.get('/google/callback', authController.handleGoogleCallback);
router.post('/send-otp', validateRequest(sendOtpSchema), authController.sendOtp);
router.post('/verify-otp', validateRequest(verifyOtpSchema), authController.verifyOtp);

// Forgot Password endpoints
router.post('/forgot-password/send-otp', validateRequest(forgotPasswordSendSchema), authController.sendForgotPasswordOtp);
router.post('/forgot-password/reset', validateRequest(resetPasswordSchema), authController.resetPasswordHandler);

// Token management
router.post('/auth-ticket', authController.exchangeAuthTicket);
router.post('/refresh-token', authController.refreshToken);
router.post('/logout', authController.logout);

module.exports = router;
