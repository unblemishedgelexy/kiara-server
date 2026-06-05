const express = require('express');
const Joi = require('joi');
const validateRequest = require('../middleware/validateRequest');
const authMiddleware = require('../middleware/authMiddleware');
const { generateTextController } = require('../controllers/aiController');

const router = express.Router();

const generateTextSchema = Joi.object({
  body: Joi.object({
    prompt: Joi.string().trim().required(),
    model: Joi.string().trim().optional(),
    temperature: Joi.number().min(0).max(1).optional(),
    candidateCount: Joi.number().integer().min(1).max(5).optional(),
    maxOutputTokens: Joi.number().integer().min(1).max(2000).optional(),
  }),
});

router.post('/generate', authMiddleware, validateRequest(generateTextSchema), generateTextController);

module.exports = router;
