'use strict';

/**
 * Anti-Repetition System
 * 
 * Tracks information already surfaced in current conversation.
 * Prevents Kiara from repeating the same fact multiple times.
 * Enables natural continuation without unnecessary re-explanation.
 */

const logger = require('./memoryLogger');

// ────────────────────────────────────────────────────────────────────
// In-Memory Tracking
// ────────────────────────────────────────────────────────────────────

// Maps userId:sessionId -> Set of surfaced memory IDs
const surfacedMemoriesPerSession = new Map();

// Timeout to clear session tracking (1 hour)
const SESSION_CLEANUP_TIMEOUT_MS = 60 * 60 * 1000;

// ────────────────────────────────────────────────────────────────────
// Session Management
// ────────────────────────────────────────────────────────────────────

/**
 * Build session key for tracking.
 */
function makeSessionKey(userId, sessionId) {
  return `${userId}:${sessionId}`;
}

/**
 * Initialize session tracking.
 */
function initializeSession(userId, sessionId) {
  const key = makeSessionKey(userId, sessionId);
  
  if (!surfacedMemoriesPerSession.has(key)) {
    surfacedMemoriesPerSession.set(key, {
      surfaced: new Set(),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    });
    
    logger.log('ANTI_REP_SESSION_START', { userId, sessionId, key });
  } else {
    const session = surfacedMemoriesPerSession.get(key);
    session.lastActivityAt = Date.now();
  }
}

/**
 * Clean up session tracking (called periodically or on session end).
 */
function cleanupSession(userId, sessionId) {
  const key = makeSessionKey(userId, sessionId);
  surfacedMemoriesPerSession.delete(key);
  logger.log('ANTI_REP_SESSION_CLEANUP', { userId, sessionId, key });
}

/**
 * Auto-cleanup old sessions.
 */
function cleanupExpiredSessions() {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [key, session] of surfacedMemoriesPerSession.entries()) {
    if (now - session.lastActivityAt > SESSION_CLEANUP_TIMEOUT_MS) {
      surfacedMemoriesPerSession.delete(key);
      cleaned += 1;
    }
  }
  
  if (cleaned > 0) {
    logger.log('ANTI_REP_SESSIONS_CLEANED', { count: cleaned });
  }
}

// ────────────────────────────────────────────────────────────────────
// API: Track & Check
// ────────────────────────────────────────────────────────────────────

/**
 * Record that a memory has been surfaced in conversation.
 * Prevents it from being re-injected unnecessarily.
 */
function recordSurfacedMemory(userId, sessionId, memoryId, memoryData = {}) {
  const key = makeSessionKey(userId, sessionId);
  initializeSession(userId, sessionId);
  
  const session = surfacedMemoriesPerSession.get(key);
  if (session) {
    session.surfaced.add(memoryId);
    session.lastActivityAt = Date.now();
    
    logger.log('ANTI_REP_RECORDED', {
      userId,
      sessionId,
      memoryId,
      totalSurfaced: session.surfaced.size,
    });
  }
}

/**
 * Check if a memory has already been surfaced.
 * Returns true if memory should NOT be re-injected.
 */
function hasAlreadySurfaced(userId, sessionId, memoryId) {
  const key = makeSessionKey(userId, sessionId);
  const session = surfacedMemoriesPerSession.get(key);
  
  if (!session) {
    return false; // Session not tracking yet
  }
  
  return session.surfaced.has(memoryId);
}

/**
 * Get all surfaced memory IDs in a session.
 */
function getSurfacedMemories(userId, sessionId) {
  const key = makeSessionKey(userId, sessionId);
  const session = surfacedMemoriesPerSession.get(key);
  
  if (!session) {
    return [];
  }
  
  return Array.from(session.surfaced);
}

/**
 * Filter memories to exclude already-surfaced ones.
 * Returns only "new" memories not yet mentioned.
 */
function filterOutSurfacedMemories(memories, userId, sessionId) {
  if (!Array.isArray(memories) || memories.length === 0) {
    return memories;
  }
  
  const key = makeSessionKey(userId, sessionId);
  const session = surfacedMemoriesPerSession.get(key);
  
  if (!session) {
    // Session not tracking; return all
    return memories;
  }
  
  const filtered = memories.filter(mem => {
    const memId = mem.id || mem._id || mem.memoryId || String(mem);
    return !session.surfaced.has(memId);
  });
  
  logger.log('ANTI_REP_FILTERED', {
    userId,
    sessionId,
    originalCount: memories.length,
    filteredCount: filtered.length,
    excluded: memories.length - filtered.length,
  });
  
  return filtered;
}

/**
 * Mark memories as already presented in Gemini's response.
 * Call this after Gemini generates response containing these memories.
 */
function markMemoriesPresented(userId, sessionId, memoryIds) {
  if (!Array.isArray(memoryIds) || memoryIds.length === 0) {
    return;
  }
  
  const key = makeSessionKey(userId, sessionId);
  initializeSession(userId, sessionId);
  
  const session = surfacedMemoriesPerSession.get(key);
  if (session) {
    for (const id of memoryIds) {
      session.surfaced.add(id);
    }
    session.lastActivityAt = Date.now();
    
    logger.log('ANTI_REP_MARKED_PRESENTED', {
      userId,
      sessionId,
      count: memoryIds.length,
      totalSurfaced: session.surfaced.size,
    });
  }
}

/**
 * Clear all surfaced memories for a session (start fresh).
 */
function clearSurfacedMemories(userId, sessionId) {
  const key = makeSessionKey(userId, sessionId);
  const session = surfacedMemoriesPerSession.get(key);
  
  if (session) {
    session.surfaced.clear();
    logger.log('ANTI_REP_CLEARED', { userId, sessionId, key });
  }
}

/**
 * Get session statistics.
 */
function getSessionStats(userId, sessionId) {
  const key = makeSessionKey(userId, sessionId);
  const session = surfacedMemoriesPerSession.get(key);
  
  if (!session) {
    return {
      active: false,
      surfacedCount: 0,
      ageMs: 0,
    };
  }
  
  return {
    active: true,
    surfacedCount: session.surfaced.size,
    ageMs: Date.now() - session.createdAt,
    lastActivityMs: Date.now() - session.lastActivityAt,
  };
}

// ────────────────────────────────────────────────────────────────────
// Startup & Cleanup
// ────────────────────────────────────────────────────────────────────

// Cleanup is now event-driven: call cleanupExpiredSessions() only when a real
// session or memory operation requires it.

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

module.exports = {
  // Session management
  initializeSession,
  cleanupSession,
  
  // Recording and checking
  recordSurfacedMemory,
  hasAlreadySurfaced,
  getSurfacedMemories,
  filterOutSurfacedMemories,
  markMemoriesPresented,
  clearSurfacedMemories,
  
  // Stats
  getSessionStats,
};
