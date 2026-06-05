const express = require('express');
const { requestPasswordReset, verifyForgotPasswordOTP, resetPassword } = require('../controllers/passwordController');

const router = express.Router();

router.post('/forgot-password', requestPasswordReset);
router.post('/verify-forgot-otp', verifyForgotPasswordOTP);
router.post('/reset-password', resetPassword);

module.exports = router;
