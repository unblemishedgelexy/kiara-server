const express = require('express');
const Joi = require('joi');
const validateRequest = require('../middleware/validateRequest');
const adminAuthController = require('../controllers/adminAuthController');

const router = express.Router();

const registerSchema = Joi.object({
  body: Joi.object({
    firstName: Joi.string().trim().min(1).max(80).required(),
    lastName: Joi.string().trim().min(1).max(80).required(),
    email: Joi.string().trim().email().lowercase().max(254).required(),
    password: Joi.string().min(12).max(128).required(),
  }).unknown(false),
});

const loginSchema = Joi.object({
  body: Joi.object({
    email: Joi.string().trim().email().lowercase().max(254).required(),
    password: Joi.string().min(1).max(128).required(),
  }).unknown(false),
});

router.post('/register', validateRequest(registerSchema), adminAuthController.register);
router.post('/login', validateRequest(loginSchema), adminAuthController.login);

module.exports = router;
