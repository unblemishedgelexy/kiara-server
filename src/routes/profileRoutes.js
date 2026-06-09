const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { getProfile, updateProfile, uploadProfilePicture } = require('../controllers/profileController');
const { upload } = require('../services/uploadService');

const router = express.Router();

router.get('/', authMiddleware, getProfile);
router.patch('/', authMiddleware, updateProfile);
router.patch('/picture', authMiddleware, upload.single('picture'), uploadProfilePicture);

module.exports = router;
