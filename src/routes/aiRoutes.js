const express = require('express');
const Joi = require('joi');
const validateRequest = require('../middleware/validateRequest');
const authMiddleware = require('../middleware/authMiddleware');
const redisAbuseProtection = require('../middleware/redisAbuseProtection');
const { generateTextController } = require('../controllers/aiController');
const { GEMINI_TEXT_MODEL } = require('../config/constants');

const router = express.Router();

const generateTextSchema = Joi.object({
  body: Joi.object({
    prompt: Joi.string().trim().required(),
    model: Joi.string().valid(GEMINI_TEXT_MODEL).optional(),
    temperature: Joi.number().min(0).max(1).optional(),
    candidateCount: Joi.number().integer().valid(1).optional(),
    maxOutputTokens: Joi.number().integer().min(1).max(2000).optional(),
  }),
});

router.post(
  '/generate',
  authMiddleware,
  redisAbuseProtection({ scope: 'account-ip', bucket: 'expensive' }),
  validateRequest(generateTextSchema),
  generateTextController,
);

module.exports = router;
