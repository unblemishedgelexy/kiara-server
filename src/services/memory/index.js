'use strict';

/**
 * Memory Intelligence Layer — Public Index
 *
 * THIS is the only file external code should ever import.
 * Everything else under services/memory/ is a private implementation detail.
 *
 * Usage:
 *   const MemoryService = require('../services/memory');
 *   await MemoryService.saveTurn({ userId, sessionId, userMessage, aiResponse });
 *   const { systemPrompt } = await MemoryService.prepareContext(userId);
 */

module.exports = require('./memory.service');
