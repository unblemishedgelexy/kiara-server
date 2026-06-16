const redisService = require('./redisService');
const memoryService = require('./memoryService');
const { summarizeConversation, analyzeConversation } = require('./geminiService');
const { env } = require('../config/env');

// Threshold for importance score (0-100)
const PROMOTION_IMPORTANCE_THRESHOLD = 60;

/**
 * Analyze STM memories and promote important ones to LTM
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Promotion statistics
 */
async function promoteStmToLtm(userId) {
  try {
    // Get all STM memories for user
    const stmMemories = await redisService.getUserShortTermMemories(userId);

    if (!stmMemories || stmMemories.length === 0) {
      console.log(`[STM→LTM] No STM memories found for user ${userId}`);
      return { promoted: 0, skipped: 0, errors: 0 };
    }

    console.log(`[STM→LTM] Processing ${stmMemories.length} STM memories for user ${userId}`);

    const stats = { promoted: 0, skipped: 0, errors: 0 };

    // Group memories by session for better context
    const sessionGroups = {};
    stmMemories.forEach((mem) => {
      const sessionId = mem.sessionId || 'default';
      if (!sessionGroups[sessionId]) {
        sessionGroups[sessionId] = [];
      }
      sessionGroups[sessionId].push(mem);
    });

    // Process each session group
    for (const [sessionId, memories] of Object.entries(sessionGroups)) {
      try {
        await promoteSessionMemories(userId, sessionId, memories, stats);
      } catch (error) {
        console.error(`[STM→LTM] Error processing session ${sessionId}:`, error);
        stats.errors += 1;
      }
    }

    console.log(`[STM→LTM] Promotion complete - Promoted: ${stats.promoted}, Skipped: ${stats.skipped}, Errors: ${stats.errors}`);
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
    // TODO: Get list of active users from database
    // For now, this can be called per-user basis
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
