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

      const { userId, sessionId, userMessage, aiResponse, ttl, conversationTurnId } = req.body;

      const result = await MemoryService.saveTurn({
        userId,
        sessionId,
        userMessage,
        aiResponse,
        ttl,
        conversationTurnId,
      });

      return res.status(200).json(result);

    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      const dependency = /redis|econnrefused|econnreset|socket/i.test(message) ? 'redis' : 'memory';
      return res.status(dependency === 'redis' ? 503 : 500).json({
        success: false,
        error: message,
        code: err && err.code ? err.code : 'SAVE_ERROR',
        dependency,
        status: dependency === 'redis' ? 'UNAVAILABLE_DEPENDENCY' : 'STORAGE_FAILURE',
      });
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
      return res.status(500).json({ success: false, error: err.message, code: err.code });
    }
  },

  /**
   * GET /api/working-memory/context?userId=...&limit=...
   */
  async getMemoryContext(req, res) {
    try {
      const { userId, limit, userQuery } = req.query;
      const result = userQuery
        ? await MemoryService.prepareContext(userId, {
          userQuery: String(userQuery),
          sessionId: req.query.sessionId || userId,
        })
        : await MemoryService.buildWorkingMemoryContext(userId, '', '', parseInt(limit) || 20);
      return res.status(200).json(result);
    } catch (err) {
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
      return res.status(500).json({ success: false, error: err.message, code: err.code });
    }
  },

  /**
   * DELETE /api/working-memory/wipe
   * Full user memory wipe across all stores
  *
   * Request body:
   * {
   *   reason: "user_request" | "admin_command"
   * }
  *
   * Returns detailed per-store deletion results
   */
  async wipeUserMemory(req, res) {
    try {
      const userId = req.userId;
      const { reason } = req.body || {};

      const wipeReason = reason || 'user_request';
      if (wipeReason !== 'user_request' && wipeReason !== 'admin_command') {
        return res.status(400).json({
          success: false,
          error: 'reason must be user_request or admin_command',
          code: 'INVALID_WIPE_REASON',
        });
      }

      if (!userId || typeof userId !== 'string' || !userId.trim()) {
        return res.status(400).json({
          success: false,
          error: 'Authenticated user is required',
          code: 'AUTH_REQUIRED',
        });
      }

      // Import wipe service
      const { wipeUserMemory } = require('../../services/memory/deletion/userMemoryWipeService');

      const result = await wipeUserMemory(userId, { reason: wipeReason });

      return res.status(200).json(result);
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: err.message,
        code: err.code || 'WIPE_ERROR',
      });
    }
  },
};

module.exports = WorkingMemoryController;
