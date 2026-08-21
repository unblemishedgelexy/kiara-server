'use strict';

/**
 * Working Memory Controller
 *
 * POST /api/working-memory/save  →  MemoryService.saveTurn()
 *   This is the ONLY save path. MemoryService handles both:
 *     1. Redis conversation turn save (synchronous, returned immediately)
 *     2. Background fact extraction + task detection (async, non-blocking)
 *
 * All other endpoints (read, stats, delete, health, debug) now delegate to
 * the central MemoryService so the application has one public entry point.
 */

const MemoryService         = require('../../services/memory');
const { log: traceLog } = require('../../services/memory/utils/memoryTrace');

const WorkingMemoryController = {

  /**
   * POST /api/working-memory/save
   * Saves complete conversation turn AND triggers background fact extraction.
   */
  async saveConversationTurn(req, res) {
    try {
      if (!require('../../config/env').env.liveMemoryEnabled) {
        return res.status(200).json({
          success: false,
          disabled: true,
          reason: 'memory_disabled_during_live_stability',
          turnId: null,
          totalTurns: 0,
          timestamp: new Date().toISOString(),
        });
      }

      console.info('[ENTERED] WorkingMemoryController.saveConversationTurn', { route: '/api/working-memory/save', timestamp: new Date().toISOString() });
      const { userId, sessionId, userMessage, aiResponse, ttl } = req.body;
      traceLog('raw_input', {
        requestId: req.requestId,
        memoryTraceId: req.memoryTraceId,
        userId,
        sessionId,
        text: String(userMessage || ''),
        source: 'frontend'
      });
      console.info('[INPUT] WorkingMemoryController.saveConversationTurn', { userId, sessionId, userMessageLength: userMessage?.length, aiResponseLength: aiResponse?.length, ttl });

      const result = await MemoryService.saveTurn({
        userId,
        sessionId,
        userMessage,
        aiResponse,
        ttl,
      });

      console.info('[OUTPUT] WorkingMemoryController.saveConversationTurn', { success: Boolean(result && result.success), turnId: result && result.turnId, totalTurns: result && result.totalTurns });
      console.info('[EXITED] WorkingMemoryController.saveConversationTurn', { route: '/api/working-memory/save', timestamp: new Date().toISOString() });

      return res.status(200).json(result);

    } catch (err) {
      console.error('[WorkingMemoryController] save error:', err && err.message ? err.message : String(err));
      return res.status(500).json({ success: false, error: err && err.message ? err.message : String(err), code: err && err.code ? err.code : 'SAVE_ERROR' });
    }
  },

  /**
   * GET /api/working-memory/recent?userId=...&limit=...
   */
  async getRecentMemory(req, res) {
    try {
      const { userId, limit } = req.query;
      const result = await MemoryService.getRecentMemory(userId, parseInt(limit) || 100);
      return res.status(200).json(result);
    } catch (err) {
      console.error('[WorkingMemoryController] getRecentMemory error:', err.message);
      return res.status(500).json({ success: false, error: err.message, code: err.code });
    }
  },

  /**
   * GET /api/working-memory/context?userId=...&limit=...
   */
  async getMemoryContext(req, res) {
    try {
      const { userId, limit } = req.query;
      const result = await MemoryService.buildWorkingMemoryContext(userId, '', '', parseInt(limit) || 20);
      return res.status(200).json(result);
    } catch (err) {
      console.error('[WorkingMemoryController] getMemoryContext error:', err.message);
      return res.status(500).json({ success: false, error: err.message, code: err.code });
    }
  },

  /**
   * GET /api/working-memory/context/:userId
   */
  async getContextByUserId(req, res) {
    try {
      const { userId } = req.params;
      const retrieval  = await MemoryService.retrieveWorkingMemory(userId, 20);
      const preview    = await MemoryService.buildWorkingMemoryContext(userId, '', '', 20, 800);
      return res.status(200).json({
        success:         true,
        memoriesFound:   retrieval.memoriesFound,
        rankedMemories:  retrieval.rankedMemories,
        contextPreview:  preview.context.slice(0, 800),
        timestamp:       new Date().toISOString(),
      });
    } catch (err) {
      console.error('[WorkingMemoryController] getContextByUserId error:', err.message);
      return res.status(500).json({ success: false, error: err.message, code: err.code });
    }
  },

  /**
   * GET /api/working-memory/stats?userId=...
   */
  async getMemoryStats(req, res) {
    try {
      const { userId } = req.query;
      const result = await MemoryService.getMemoryStats(userId);
      return res.status(200).json(result);
    } catch (err) {
      console.error('[WorkingMemoryController] getMemoryStats error:', err.message);
      return res.status(500).json({ success: false, error: err.message, code: err.code });
    }
  },

  /**
   * DELETE /api/working-memory/delete?userId=...
   */
  async deleteUserMemory(req, res) {
    try {
      const { userId } = req.query;
      const result = await MemoryService.deleteUserMemory(userId);
      return res.status(200).json(result);
    } catch (err) {
      console.error('[WorkingMemoryController] deleteUserMemory error:', err.message);
      return res.status(500).json({ success: false, error: err.message, code: err.code });
    }
  },

  /**
   * GET /api/working-memory/health
   */
  async getHealth(req, res) {
    try {
      const result   = await MemoryService.getHealth();
      const response = {
        ...result,
        redisConnected: Boolean(result.healthy),
        redisReady:     Boolean(result.healthy),
      };
      return res.status(200).json(response);
    } catch (err) {
      console.error('[WorkingMemoryController] health error:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  },

  /**
   * GET /api/working-memory/debug?userId=...
   */
  async getDebugInfo(req, res) {
    try {
      const { userId } = req.query;
      const memory = await MemoryService.getRecentMemory(userId, 100);
      const stats  = await MemoryService.getMemoryStats(userId);
      return res.status(200).json({ success: true, userId, memory, stats, timestamp: new Date().toISOString() });
    } catch (err) {
      console.error('[WorkingMemoryController] getDebugInfo error:', err.message);
      return res.status(500).json({ success: false, error: err.message, code: err.code });
    }
  },
};

module.exports = WorkingMemoryController;
