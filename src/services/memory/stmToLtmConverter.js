const redisService = require('../infrastructure/redisService');
const sessionMemoryService = require('./sessionMemoryService');
const memoryService = require('./memoryService');
const { summarizeConversation, analyzeConversation } = require('../live/geminiService');
const { env } = require('../../config/env');
const { ensureUserId } = require('../../utils/ensureUserId');

// Threshold for importance score (0-100)
const PROMOTION_IMPORTANCE_THRESHOLD = 60;

/**
 * Analyze STM memories and promote important ones to LTM
 * @param {string} userId - User ID
 * @param {string} [sessionId] - Session ID to promote
 * @returns {Promise<Object>} Promotion statistics
 */
async function promoteStmToLtm(userId, sessionId = null) {
  try {
    const safeUserId = ensureUserId(userId);
    let safeSessionId = sessionId && typeof sessionId === 'string' ? sessionId.trim() : null;

    if (!safeSessionId) {
      const activeSession = await sessionMemoryService.getActiveSessionMemory(safeUserId).catch(() => null);
      safeSessionId = activeSession?.lastSessionId || null;
    }

    if (!safeSessionId) {
      console.log(`[STM→LTM] No sessionId available for user ${safeUserId}`);
      return { promoted: 0, skipped: 0, errors: 0, message: 'no sessionId' };
    }

    const memories = await redisService.getShortTermMemory(safeUserId, safeSessionId);
    if (!memories || memories.length === 0) {
      console.log(`[STM→LTM] No STM memories found for user ${safeUserId}, session ${safeSessionId}`);
      return { promoted: 0, skipped: 0, errors: 0 };
    }

    const stats = { promoted: 0, skipped: 0, errors: 0 };
    await promoteSessionMemories(safeUserId, safeSessionId, memories, stats);

    console.log(`[STM→LTM] Promotion complete for user ${safeUserId}, session ${safeSessionId} - Promoted: ${stats.promoted}, Skipped: ${stats.skipped}, Errors: ${stats.errors}`);
    return stats;
  } catch (error) {
    console.error('[STM→LTM] Error in promoteStmToLtm:', error);
    throw error;
  }
}

/**
 * Process and promote memories from a specific session
 * @private
 */
async function promoteSessionMemories(userId, sessionId, memories, stats) {
  if (!memories || memories.length === 0) return;

  // Build conversation transcript
  const transcript = memories
    .map((mem) => `${mem.role === 'assistant' ? 'Kiara' : 'User'}: ${mem.message}`)
    .join('\n');

  if (!transcript.trim()) return;

  // Analyze conversation
  const analysis = await analyzeConversation(transcript);

  if (!analysis.shouldStore) {
    console.log(`[STM→LTM] Session ${sessionId}: Not important enough to store`);
    stats.skipped += memories.length;
    return;
  }

  // Save to LTM
  try {
    const result = await memoryService.analyzeAndSaveLongTerm({
      userId,
      text: analysis.memory,
    });

    if (result.stored) {
      console.log(`[STM→LTM] Session ${sessionId}: Promoted ${memories.length} memories to LTM`);
      stats.promoted += memories.length;

      // Delete from STM after successful promotion
      await redisService.deleteShortTermMemory(userId, sessionId);
    } else {
      stats.skipped += memories.length;
    }
  } catch (error) {
    console.error(`[STM→LTM] Error saving to LTM for session ${sessionId}:`, error);
    stats.errors += 1;
  }
}

/**
 * Scheduled job to promote STM→LTM for all active users
 * Run this periodically (e.g., every 1 hour)
 */
async function runScheduledPromotion() {
  try {
    console.log('[STM→LTM] Starting scheduled promotion job...');
    const activeUserIds = await sessionMemoryService.listActiveSessions().catch(() => []);
    for (const userId of activeUserIds) {
      try {
        const activeSession = await sessionMemoryService.getActiveSessionMemory(userId).catch(() => null);
        const sessionId = activeSession?.lastSessionId;
        if (!sessionId) continue;
        await promoteStmToLtm(userId, sessionId);
      } catch (error) {
        console.error(`[STM→LTM] Scheduled promotion failed for user ${userId}:`, error);
      }
    }
  } catch (error) {
    console.error('[STM→LTM] Scheduled promotion job failed:', error);
  }
}

/**
 * Manual promotion endpoint - convert specific STM to LTM
 * @param {string} userId - User ID
 * @param {string} sessionId - Session ID
 * @returns {Promise<Object>} Result
 */
async function manualPromoteSession(userId, sessionId) {
  try {
    const memories = await redisService.getShortTermMemory(userId, sessionId);

    if (!memories || memories.length === 0) {
      return { success: false, message: 'No memories found in session' };
    }

    const stats = { promoted: 0, skipped: 0, errors: 0 };
    await promoteSessionMemories(userId, sessionId, memories, stats);

    return {
      success: true,
      stats,
      message: `Promoted ${stats.promoted} memories to LTM`,
    };
  } catch (error) {
    console.error('[STM→LTM] Manual promotion failed:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  promoteStmToLtm,
  runScheduledPromotion,
  manualPromoteSession,
  PROMOTION_IMPORTANCE_THRESHOLD,
};
