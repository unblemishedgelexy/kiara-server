const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { getProfile, updateProfile, uploadProfilePicture } = require('../controllers/profileController');
const { requestEmailVerificationOTP, verifyEmailOTPFromProfile } = require('../controllers/authControllerV2');
const authValidation = require('../middleware/authValidation');
const { upload } = require('../services/../services/infrastructure/uploadService');

const router = express.Router();

router.get('/', authMiddleware, getProfile);
router.patch('/', authMiddleware, updateProfile);
router.patch('/picture', authMiddleware, upload.single('picture'), uploadProfilePicture);

router.post('/verify-email/send-otp', authMiddleware, authValidation.validateRequestEmailVerificationOTP, requestEmailVerificationOTP);
router.post('/verify-email/confirm', authMiddleware, authValidation.validateVerifyEmailOTPRequest, verifyEmailOTPFromProfile);

module.exports = router;
