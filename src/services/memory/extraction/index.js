'use strict';

const { extract } = require('./memoryExtractor');
const { analyzeConversation } = require('./memoryGroqAnalyzer');
const { normalizeCandidate } = require('./memoryNormalizer');
const { classifyMemoryType, normalizeMemoryType } = require('./memoryClassifier');
const { VALID_DECISIONS, assertDecision } = require('./extractionContract');

module.exports = {
  extract,
  analyzeConversation,
  normalizeCandidate,
  classifyMemoryType,
  normalizeMemoryType,
  VALID_DECISIONS,
  assertDecision,
};
