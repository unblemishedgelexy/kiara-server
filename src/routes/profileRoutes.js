const express = require('express');
const Joi = require('joi');
const authMiddleware = require('../middleware/authMiddleware');
const redisAbuseProtection = require('../middleware/redisAbuseProtection');
const { getProfile, updateProfile, uploadProfilePicture } = require('../controllers/profileController');
const { requestEmailVerificationOTP, verifyEmailOTPFromProfile } = require('../controllers/authControllerV2');
const {
  createSupportRequest,
  getSessionFeedbackStatus,
} = require('../controllers/supportController');
const accountDeletionController = require('../controllers/accountDeletionController');
const authValidation = require('../middleware/authValidation');
const { upload } = require('../services/../services/infrastructure/uploadService');
const validateRequest = require('../middleware/validateRequest');

const router = express.Router();
const sensitiveActionSchema = validateRequest(Joi.object({
  body: Joi.object({
    password: Joi.string().max(256).allow(''),
    code: Joi.string().pattern(/^\d{6}$/),
  }),
}));

router.use(authMiddleware);
router.use(redisAbuseProtection({
  scope: 'account-ip',
  bucket: 'api-protected',
  additionalIpBuckets: ['api'],
}));

router.get('/', getProfile);
router.patch('/', updateProfile);
router.patch('/picture', upload.single('picture'), uploadProfilePicture);
router.get('/account-deletion', accountDeletionController.getDeletionStatus);
router.post('/account-deletion', sensitiveActionSchema, accountDeletionController.requestDeletion);
router.delete('/account-deletion', accountDeletionController.cancelDeletion);
router.post('/memory-deletion', sensitiveActionSchema, accountDeletionController.requestMemoryDeletion);

router.post('/verify-email/send-otp', authValidation.validateRequestEmailVerificationOTP, requestEmailVerificationOTP);
router.post('/verify-email/confirm', authValidation.validateVerifyEmailOTPRequest, verifyEmailOTPFromProfile);
router.get('/support-requests/session-feedback/status', getSessionFeedbackStatus);
router.post('/support-requests', createSupportRequest);

module.exports = router;
