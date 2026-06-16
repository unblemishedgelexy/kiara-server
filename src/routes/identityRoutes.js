const express = require('express');
const {
  recognizeFaceController,
  recognizeVoiceController,
  processInteractionController,
  learnPersonController,
  listPeopleController,
  getStatsController,
  upload,
} = require('../controllers/identityController');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

// Recognize endpoints - expect embeddings as JSON (not file upload)
router.post('/recognize-face', recognizeFaceController);
router.post('/recognize-voice', recognizeVoiceController);

// Process interaction with face and/or voice
router.post('/process', processInteractionController);

// Learn a new person
router.post('/learn-person', learnPersonController);

// Get known people
router.get('/people', listPeopleController);

// Get stats
router.get('/stats', getStatsController);

module.exports = router;
