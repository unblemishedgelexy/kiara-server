/**
 * Working Memory Routes
 * 
 * Base path: /api/working-memory
 */

const express = require('express');
const router = express.Router();

const WorkingMemoryController = require('../controllers/workingMemory/workingMemory.controller');
const WorkingMemoryMiddleware = require('../middleware/workingMemory/workingMemory.middleware');
const authMiddleware = require('../middleware/authMiddleware');
const { env } = require('../config/env');

const memoryDisabledResponse = (res) => res.status(200).json({
  success: true,
  skipped: true,
  reason: 'memory_disabled_for_live_stability',
  enabled: false,
  timestamp: new Date().toISOString(),
});

router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE') {
    if (!env.liveMemoryEnabled) {
      if (req.path === '/health') {
        return res.status(200).json({ healthy: false, ok: false, enabled: false, reason: 'memory_disabled_for_live_stability' });
      }
      return memoryDisabledResponse(res);
    }
  }
  next();
});

router.use(WorkingMemoryMiddleware.logRequests);

/**
 * GET /api/working-memory/health
 */
router.get('/health', WorkingMemoryController.getHealth);

router.use(authMiddleware);
router.use(WorkingMemoryMiddleware.bindAuthenticatedUser);

/**
 * POST /api/working-memory/save
 * Save a complete conversation turn
 * 
 * Body:
 * {
 *   userId: string (required),
 *   sessionId: string (required),
 *   userMessage: string (required, COMPLETE message),
 *   aiResponse: string (required, COMPLETE response),
 *   ttl: number (optional, default 3600)
 * }
 * 
 * Response:
 * {
 *   success: boolean,
 *   memorySaved: boolean,
 *   totalTurns: number,
 *   ttl: number,
 *   timestamp: ISO8601
 * }
 */
router.post(
  '/save',
  WorkingMemoryMiddleware.validateSaveRequest,
  WorkingMemoryController.saveConversationTurn
);

/**
 * GET /api/working-memory/recent
 * Get recent memory for user
 * 
 * Query:
 *   userId: string (required)
 *   limit: number (optional, default 100, max 100)
 * 
 * Response:
 * {
 *   success: boolean,
 *   turns: Array<{turnId, timestamp, sessionId, userMessage, aiResponse}>,
 *   totalTurns: number,
 *   contextSize: number (bytes),
 *   timestamp: ISO8601
 * }
 */
router.get(
  '/recent',
  WorkingMemoryMiddleware.validateQueryRequest,
  WorkingMemoryMiddleware.validateLimitParameter,
  WorkingMemoryController.getRecentMemory
);

/**
 * GET /api/working-memory/context
 * Get formatted memory context for Gemini
 * 
 * Query:
 *   userId: string (required)
 *   limit: number (optional, default 100, max 100)
 * 
 * Response:
 * {
 *   success: boolean,
 *   context: string (formatted conversation history),
 *   messagesUsed: number,
 *   totalCharacters: number,
 *   turns: Array<turn>,
 *   sessionIds: Array<string>,
 *   turnCount: number,
 *   timestamp: ISO8601
 * }
 */
router.get(
  '/context',
  WorkingMemoryMiddleware.validateQueryRequest,
  WorkingMemoryMiddleware.validateLimitParameter,
  WorkingMemoryController.getMemoryContext
);

// Debug route: GET /api/working-memory/context/:userId
router.get('/context/:userId', WorkingMemoryController.getContextByUserId);

/**
 * GET /api/working-memory/stats
 * Get memory statistics
 * 
 * Query:
 *   userId: string (required)
 * 
 * Response:
 * {
 *   success: boolean,
 *   userId: string,
 *   conversationTurns: number,
 *   totalMessages: number,
 *   totalCharacters: number,
 *   ttl: number (seconds),
 *   maxTurns: number (100),
 *   memoryUsagePercent: number,
 *   timestamp: ISO8601
 * }
 */
router.get(
  '/stats',
  WorkingMemoryMiddleware.validateQueryRequest,
  WorkingMemoryController.getMemoryStats
);

/**
 * DELETE /api/working-memory/delete
 * Delete all memory for user (session ended)
 * 
 * Query:
 *   userId: string (required)
 * 
 * Response:
 * {
 *   success: boolean,
 *   deleted: boolean,
 *   userId: string,
 *   timestamp: ISO8601
 * }
 */
router.delete(
  '/delete',
  WorkingMemoryMiddleware.validateQueryRequest,
  WorkingMemoryController.deleteUserMemory
);

/**
 * GET /api/working-memory/debug
 * Debug information (development only)
 * 
 * Query:
 *   userId: string (required)
 * 
 * Response:
 * {
 *   success: boolean,
 *   userId: string,
 *   memory: Object,
 *   stats: Object,
 *   timestamp: ISO8601
 * }
 */
router.get(
  '/debug',
  WorkingMemoryMiddleware.validateQueryRequest,
  WorkingMemoryController.getDebugInfo
);

// Error handler
router.use(WorkingMemoryMiddleware.errorHandler);

module.exports = router;
