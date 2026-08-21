/**
 * Working Memory Logger
 * 
 * Provides structured logging for all working memory operations.
 * All logs include timestamps and context information.
 */

class WorkingMemoryLogger {
  /**
   * LOG 1: Message received from frontend
   */
  static logMessageReceived(userId, sessionId, messageLength, message) {
    return;
  }

  /**
   * LOG 2: Before saving to Redis
   */
  // Deprecated: use more structured outputs in saveConversationTurn flow
  static logBeforeSave() { return; }

  static logValidation(userId, sessionId, valid, reason = null) {
    return;
  }

  static logDuplicate(userId, sessionId, turnKey, duplicate) {
    return;
  }

  static logRedisBeforeSave() { return; }

  // Structured short term memory save output
  static logShortTermMemory(userId, sessionId, redisKey, previousTurns, currentTurns, ttl, saveDurationMs, status) {
    console.log('📤 STM Saved', JSON.stringify({ userId, sessionId, redisKey, previousTurns, currentTurns, ttl, saveDurationMs, status, timestamp: new Date().toISOString() }));
  }

  static logMongoDocument(collection, document) {
    return;
  }

  static logContextPreparing() { /* suppressed; prompt builder will print final context */ }
  static logContextBuilt() { /* suppressed to avoid duplicate logs */ }

  static logFilter(filterName, inputCount, outputCount, durationMs, removedItems, reason) {
    return;
  }

  /**
   * LOG 3: After saving to Redis
   */
  static logAfterSave() { return; }

  /**
   * LOG 4: Memory retrieved from Redis
   */
  static logMemoryRetrieved(userId, sessionId, totalTurns, contextSize) {
    console.log('📖 STM Retrieved', JSON.stringify({ userId, totalTurns, contextSize, timestamp: new Date().toISOString() }));
  }

  /**
   * LOG 5: Context sent to Gemini
   */
  static logContextToGemini(userId, sessionId, messagesUsed, totalCharacters) {
    console.log('🤖 Context Sent To Gemini', JSON.stringify({ userId, sessionId, messagesUsed, totalCharacters, timestamp: new Date().toISOString() }));
  }

  /**
   * LOG 6: Gemini response received
   */
  static logGeminiResponse(userId, sessionId, responseLength) {
    return;
  }

  /**
   * LOG 7: Error occurred
   */
  static logError(errorName, errorMessage, stackTrace, userId, sessionId) {
    console.error('[ERROR]', JSON.stringify({
      errorName,
      message: errorMessage,
      stackTrace: stackTrace ? String(stackTrace).split('\n').slice(0, 8).join(' | ') : null,
      userId: userId || 'unknown',
      sessionId: sessionId || 'unknown',
      timestamp: new Date().toISOString(),
    }));
  }

  /**
   * Log memory trimming action
   */
  static logMemoryTrimmed(userId, removedCount, remainingCount) {
    return;
  }

  /**
   * Log memory deletion
   */
  static logMemoryDeleted(userId, sessionId, redisKey) {
    return;
  }

  /**
   * Log debug info
   */
  static logDebug(userId, sessionId, message, data) {
    return;
  }
}

module.exports = WorkingMemoryLogger;
