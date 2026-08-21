/**
 * Working Memory Middleware
 * 
 * Middleware for working memory operations
 * - Input validation
 * - Rate limiting
 * - Authentication checks
 */

const {
  InvalidUserError,
  MissingSessionError,
  EmptyMessageError,
} = require('../../utils/workingMemory/errors');

class WorkingMemoryMiddleware {
  static _generateId(prefix = 's') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  static bindAuthenticatedUser(req, res, next) {
    console.info('[ENTERED] WorkingMemoryMiddleware.bindAuthenticatedUser', { timestamp: new Date().toISOString() });
    const authenticatedUserId = req.userId ? String(req.userId).trim() : '';

    if (!authenticatedUserId) {
      console.info('[OUTPUT] WorkingMemoryMiddleware.bindAuthenticatedUser', { result: 'no-auth' });
      return res.status(401).json({
        success: false,
        error: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
    }

    const suppliedUserIds = [
      req.body?.userId,
      req.query?.userId,
      req.params?.userId,
    ]
      .filter((value) => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim());

    if (suppliedUserIds.some((userId) => userId !== authenticatedUserId)) {
      return res.status(403).json({
        success: false,
        error: 'Authenticated user does not match requested userId',
        code: 'USER_SCOPE_MISMATCH',
      });
    }

    if (req.body && typeof req.body === 'object') {
      req.body.userId = authenticatedUserId;
    }
    if (req.query && typeof req.query === 'object') {
      req.query.userId = authenticatedUserId;
    }
    if (req.params && typeof req.params === 'object' && 'userId' in req.params) {
      req.params.userId = authenticatedUserId;
    }
    console.info('[OUTPUT] WorkingMemoryMiddleware.bindAuthenticatedUser', { result: 'bound', userId: authenticatedUserId });
    next();
  }

  /**
   * Validate save request
   * Ensures userId, sessionId, userMessage, and aiResponse are present
   */
  static validateSaveRequest(req, res, next) {
    try {
      if (!require('../../config/env').env.liveMemoryEnabled) {
        return res.status(200).json({
          success: true,
          skipped: true,
          reason: 'memory_disabled_for_live_stability',
          enabled: false,
          timestamp: new Date().toISOString(),
        });
      }
      console.info('[ENTERED] WorkingMemoryMiddleware.validateSaveRequest', { timestamp: new Date().toISOString() });
      let { userId, sessionId, userMessage, aiResponse, conversationId } = req.body || {};

      // If sessionId is missing or a placeholder like 'unknown', generate server-side IDs
      if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0 || String(sessionId).trim().toLowerCase() === 'unknown') {
        sessionId = WorkingMemoryMiddleware._generateId('session');
        req.body.sessionId = sessionId;
      }

      if (!conversationId || typeof conversationId !== 'string' || conversationId.trim().length === 0 || String(conversationId).trim().toLowerCase() === 'unknown') {
        conversationId = WorkingMemoryMiddleware._generateId('conversation');
        req.body.conversationId = conversationId;
      }

      ({ userId, sessionId, userMessage, aiResponse } = req.body);

      console.info('[INPUT] WorkingMemoryMiddleware.validateSaveRequest', { userId, sessionId, userMessageLength: userMessage?.length, aiResponseLength: aiResponse?.length });

      // Validate userId
      if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
        console.info('[OUTPUT] WorkingMemoryMiddleware.validateSaveRequest', { result: 'invalid_user' });
        return res.status(400).json({
          success: false,
          error: 'Invalid userId',
          code: 'INVALID_USER_ID',
        });
      }

      // Validate sessionId
      if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
        // Session validation logging disabled
        return res.status(400).json({
          success: false,
          error: 'Invalid sessionId',
          code: 'INVALID_SESSION_ID',
        });
      }

      // Validate userMessage (MUST be complete, not streaming)
      if (!userMessage || typeof userMessage !== 'string' || userMessage.trim().length === 0) {
        console.info('[OUTPUT] WorkingMemoryMiddleware.validateSaveRequest', { result: 'empty_user_message' });
        return res.status(400).json({
          success: false,
          error: 'User message cannot be empty',
          code: 'EMPTY_USER_MESSAGE',
        });
      }

      // Validate aiResponse (MUST be complete, not streaming)
      if (!aiResponse || typeof aiResponse !== 'string' || aiResponse.trim().length === 0) {
        console.info('[OUTPUT] WorkingMemoryMiddleware.validateSaveRequest', { result: 'empty_ai_response' });
        return res.status(400).json({
          success: false,
          error: 'AI response cannot be empty',
          code: 'EMPTY_AI_RESPONSE',
        });
      }

      // Check for streaming/partial indicators
      // These should NOT be in a "save" request - data must be complete
      if (userMessage.includes('[STREAMING]') || userMessage.includes('[INCOMPLETE]')) {
        console.info('[OUTPUT] WorkingMemoryMiddleware.validateSaveRequest', { result: 'incomplete_user' });
        return res.status(400).json({
          success: false,
          error: 'User message appears to be incomplete/streaming. Wait for complete message before saving.',
          code: 'INCOMPLETE_USER_MESSAGE',
        });
      }

      if (aiResponse.includes('[STREAMING]') || aiResponse.includes('[INCOMPLETE]')) {
        console.info('[OUTPUT] WorkingMemoryMiddleware.validateSaveRequest', { result: 'incomplete_ai' });
        return res.status(400).json({
          success: false,
          error: 'AI response appears to be incomplete/streaming. Wait for complete response before saving.',
          code: 'INCOMPLETE_AI_RESPONSE',
        });
      }

      console.info('[EXITED] WorkingMemoryMiddleware.validateSaveRequest', { result: 'valid', userId, sessionId });
      next();
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
        code: 'VALIDATION_ERROR',
      });
    }
  }

  /**
   * Validate get/query requests
   * Ensures userId is present in query params
   */
  static validateQueryRequest(req, res, next) {
    try {
      const { userId } = req.query;

      if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
        return res.status(400).json({
          success: false,
          error: 'userId is required',
          code: 'MISSING_USER_ID',
        });
      }

      next();
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
        code: 'VALIDATION_ERROR',
      });
    }
  }

  /**
   * Validate limit parameter
   * Ensures limit is a positive number
   */
  static validateLimitParameter(req, res, next) {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit) : 100;

      if (isNaN(limit) || limit < 1 || limit > 100) {
        return res.status(400).json({
          success: false,
          error: 'limit must be between 1 and 100',
          code: 'INVALID_LIMIT',
        });
      }

      // Store validated limit in request
      req.validatedLimit = limit;

      next();
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
        code: 'VALIDATION_ERROR',
      });
    }
  }

  /**
   * Basic rate limiting (simple implementation)
   * Could be enhanced with Redis-based rate limiting
   */
  static createRateLimiter(maxRequests = 100, windowMs = 60000) {
    const requests = new Map();

    return (req, res, next) => {
      try {
        const userId = req.query.userId || req.body?.userId;
        const now = Date.now();
        const key = `${userId}:${Math.floor(now / windowMs)}`;

        if (!requests.has(key)) {
          requests.set(key, 0);
        }

        const count = requests.get(key);

        if (count >= maxRequests) {
          return res.status(429).json({
            success: false,
            error: 'Rate limit exceeded',
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfter: Math.ceil(windowMs / 1000),
          });
        }

        requests.set(key, count + 1);

        // Clean up old entries
        if (Math.random() < 0.01) {
          for (const [k] of requests) {
            const windowKey = k.split(':')[1];
            const currentWindow = Math.floor(now / windowMs);
            if (parseInt(windowKey) < currentWindow - 1) {
              requests.delete(k);
            }
          }
        }

        next();
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message,
          code: 'RATE_LIMITER_ERROR',
        });
      }
    };
  }

  /**
   * Error handler for working memory routes
   */
  static errorHandler(err, req, res, next) {
    console.error('[WorkingMemoryMiddleware] Error:', err.message);

    const statusCode = err.statusCode || 500;
    const code = err.code || 'UNKNOWN_ERROR';

    res.status(statusCode).json({
      success: false,
      error: err.message,
      code: code,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Log all working memory requests (debugging)
   */
  static logRequests(req, res, next) {
    // Suppressed request-level logs to reduce noise; errors still reported.
    return next();
  }
}

module.exports = WorkingMemoryMiddleware;
