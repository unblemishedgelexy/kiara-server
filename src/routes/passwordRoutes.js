const express = require('express');
const Joi = require('joi');
const validateRequest = require('../middleware/validateRequest');
const { resetPassword } = require('../controllers/passwordController');

const router = express.Router();

const resetPasswordSchema = Joi.object({
  body: Joi.object({
    resetToken: Joi.string().hex().length(64).required(),
    newPassword: Joi.string().min(8).required(),
  }),
});

router.post('/reset-password', validateRequest(resetPasswordSchema), resetPassword);

module.exports = router;
