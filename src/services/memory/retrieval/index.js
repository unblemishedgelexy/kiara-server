'use strict';

const { MemoryRetriever } = require('./memoryRetriever');
const { buildContext } = require('./memoryContextBuilder');
const { analyzeQuery, inferIntent, extractKeywords, extractEntities, inferTemporalHints } = require('./queryAnalyzer');
const { rankMemories, scoreMemory } = require('./relevanceRanker');
const { validateRetrievalResult } = require('./retrievalContract');
const { MEMORY_INTENTS, INTENT_TO_MEMORY_TYPES, normalizeIntent, isHistoricalQuery, isCurrentQuery, shouldIncludeHistory, isRecentContextQuery } = require('./retrievalPolicy');

module.exports = {
  MemoryRetriever,
  buildContext,
  analyzeQuery,
  inferIntent,
  extractKeywords,
  extractEntities,
  inferTemporalHints,
  rankMemories,
  scoreMemory,
  validateRetrievalResult,
  MEMORY_INTENTS,
  INTENT_TO_MEMORY_TYPES,
  normalizeIntent,
  isHistoricalQuery,
  isCurrentQuery,
  shouldIncludeHistory,
  isRecentContextQuery,
};
