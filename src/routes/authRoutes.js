const express = require('express');
const Joi = require('joi');
const validateRequest = require('../middleware/validateRequest');
const { register, verifyEmailOTP, verifyMobileOTP, login, googleLogin, refreshToken, logout, guestSession } = require('../controllers/authController');

const router = express.Router();

const registerSchema = Joi.object({
  body: Joi.object({
    firstName: Joi.string().trim().required(),
    lastName: Joi.string().trim().required(),
    email: Joi.string().email().required(),
    mobileNumber: Joi.string().trim().required(),
    password: Joi.string().min(8).required(),
  }),
});

const verifyEmailSchema = Joi.object({
  body: Joi.object({
    email: Joi.string().email().required(),
    code: Joi.string().length(6).required(),
  }),
});

const verifyMobileSchema = Joi.object({
  body: Joi.object({
    mobileNumber: Joi.string().trim().required(),
    code: Joi.string().length(6).required(),
  }),
});

const loginSchema = Joi.object({
  body: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required(),
  }),
});

const googleLoginSchema = Joi.object({
  body: Joi.object({
    idToken: Joi.string().required(),
    mobileNumber: Joi.string().trim().optional(),
  }),
});

router.post('/register', validateRequest(registerSchema), register);
router.post('/verify-email-otp', validateRequest(verifyEmailSchema), verifyEmailOTP);
router.post('/verify-mobile-otp', validateRequest(verifyMobileSchema), verifyMobileOTP);
router.post('/login', validateRequest(loginSchema), login);
router.post('/google-login', validateRequest(googleLoginSchema), googleLogin);
router.post('/refresh-token', refreshToken);
router.post('/logout', logout);
router.post('/guest', guestSession);

module.exports = router;
