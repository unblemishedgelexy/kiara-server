const express = require('express');
const router = express.Router();
const memoryController = require('../controllers/memoryController');
const debugController = require('../controllers/debugController');
const authMiddleware = require('../middleware/authMiddleware');
const { adminOnlyMiddleware } = require('../middleware/adminMiddleware');
// V7: User isolation middleware
const { userIsolationMiddleware } = require('../services/memory/userIsolationValidator');

router.use(authMiddleware);
// V7: Enforce user isolation on all memory routes
router.use(userIsolationMiddleware);

router.post('/process',  memoryController.processMemory);
router.get('/bootstrap',  memoryController.getBootstrap);
router.get('/prompt-preview', memoryController.getPromptPreview);
router.get('/state',  memoryController.getState);
router.post('/state',  memoryController.updateState);
router.get('/profile',  memoryController.getProfile);
router.post('/profile/rebuild',  memoryController.rebuildProfile);
router.get('/health',  memoryController.getHealth);
router.get('/queue/health', memoryController.getQueueHealth);
router.get('/worker-health',  memoryController.getWorkerHealth);
router.get('/verification', memoryController.getVerification);
router.get('/stats',  memoryController.getStats);
router.get('/debug',  memoryController.debugMemory);
router.get('/debug/db-counts', memoryController.getDbCounts);
router.get('/debug/overview',  debugController.debugOverview);
router.get('/debug/full',  memoryController.debugMemoryFull);
router.get('/lab/overview', adminOnlyMiddleware, memoryController.getLabOverview);
router.get('/lab/prompt-audit', adminOnlyMiddleware, memoryController.getLabPromptAudit);
router.get('/lab/verification', adminOnlyMiddleware, memoryController.getLabVerification);
router.get('/lab/accuracy', adminOnlyMiddleware, memoryController.getLabAccuracy);
router.get('/lab/queue', adminOnlyMiddleware, memoryController.getLabQueue);
router.get('/lab/session', adminOnlyMiddleware, memoryController.getLabSession);
router.get('/continuity/:userId',  memoryController.getContinuity);
router.get('/continuity-packet/:userId',  memoryController.getContinuityPacket);
router.get('/continuity-packet',  memoryController.getContinuityPacket);

// V6 ROUTES
router.get('/v6/sacred', memoryController.v6GetSacredMemories);
router.post('/v6/sacred', memoryController.v6SaveSacredMemory);
router.get('/v6/relationships/graph', memoryController.v6GetRelationshipGraph);
router.get('/v6/relationships/summary', memoryController.v6GetRelationshipSummary);
router.get('/v6/context/:sessionId', memoryController.v6GetActiveContext);
router.post('/v6/context/:sessionId', memoryController.v6UpdateActiveContext);
router.get('/v6/recall', memoryController.v6RecallMemories);
router.post('/v6/recall', memoryController.v6RecallMemories);
router.get('/v6/people', memoryController.v6GetAllPeople);
router.get('/v6/people/:name', memoryController.v6GetPerson);
router.get('/v6/followups', memoryController.v6GetPendingFollowUps);
router.get('/v6/startup/:sessionId', memoryController.v6GetSessionStartupContext);
router.get('/v6/health', memoryController.v6GetHealth);
router.get('/v6/stats', memoryController.v6GetStats);
router.get('/v65/integrity', memoryController.v65GetIntegrity);
router.get('/v65/conflicts', memoryController.v65GetConflicts);
router.get('/v65/cache', memoryController.v65GetCache);
router.get('/v65/continuity', memoryController.v65GetContinuity);

module.exports = router;
