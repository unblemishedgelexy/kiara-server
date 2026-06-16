const express = require('express');
const router = express.Router();
const memoryController = require('../controllers/memoryController');
const authMiddleware = require('../middleware/authMiddleware');

router.get('/context', authMiddleware, memoryController.getContext);
router.post('/messages', authMiddleware, memoryController.saveMessage);

router.post('/short/add', authMiddleware, memoryController.addShort);
router.get('/short/:sessionId', authMiddleware, memoryController.getShort);
router.delete('/short/:sessionId', authMiddleware, memoryController.deleteShort);

router.post('/long/analyze', authMiddleware, memoryController.analyzeLong);
router.get('/long', authMiddleware, memoryController.getLong);
router.get('/long/search', authMiddleware, memoryController.searchLong);
router.delete('/long/:id', authMiddleware, memoryController.deleteLong);
router.patch('/long/:id', authMiddleware, memoryController.patchLong);

// STM to LTM conversion routes
router.post('/promote/:sessionId', authMiddleware, memoryController.promoteStmSession);
router.post('/promote-all', authMiddleware, memoryController.promoteAllStm);

module.exports = router;
