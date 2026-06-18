const express = require('express');
const router = express.Router();
const memoryController = require('../controllers/memoryController');
const debugController = require('../controllers/debugController');
const authMiddleware = require('../middleware/authMiddleware');

router.use(authMiddleware);

router.post('/process',  memoryController.processMemory);
router.get('/bootstrap',  memoryController.getBootstrap);
router.get('/state',  memoryController.getState);
router.post('/state',  memoryController.updateState);
router.get('/profile',  memoryController.getProfile);
router.post('/profile/rebuild',  memoryController.rebuildProfile);
router.get('/health',  memoryController.getHealth);
router.get('/stats',  memoryController.getStats);
router.get('/debug',  memoryController.debugMemory);
router.get('/debug/overview',  debugController.debugOverview);
router.get('/debug/full',  memoryController.debugMemoryFull);
router.get('/continuity/:userId',  memoryController.getContinuity);
router.get('/continuity-packet/:userId',  memoryController.getContinuityPacket);
router.get('/continuity-packet',  memoryController.getContinuityPacket);

module.exports = router;
