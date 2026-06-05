const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { getProfile, updateProfile, requestEmailUpdate, verifyEmailUpdate, requestMobileUpdate, verifyMobileUpdate, uploadProfilePicture } = require('../controllers/profileController');
const { upload } = require('../services/uploadService');

const router = express.Router();

router.get('/', authMiddleware, getProfile);
router.patch('/', authMiddleware, updateProfile);
router.patch('/email', authMiddleware, requestEmailUpdate);
router.patch('/email/verify', authMiddleware, verifyEmailUpdate);
router.patch('/mobile', authMiddleware, requestMobileUpdate);
router.patch('/mobile/verify', authMiddleware, verifyMobileUpdate);
router.patch('/picture', authMiddleware, upload.single('picture'), uploadProfilePicture);

module.exports = router;
