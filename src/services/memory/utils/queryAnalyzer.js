'use strict';

/**
 * Query Analyzer
 * 
 * Lightweight analysis of user queries to enable intelligent memory retrieval.
 * Extracts:
 *   - intent (recall, fact_check, current_state, etc.)
 *   - entities (person names, project names, dates)
 *   - keywords (topics, themes)
 *   - temporal hints (today, yesterday, "last week")
 *   - conversational references ("that", "it", "the project")
 */

const logger = require('./memoryLogger');

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

const IDENTITY_PATTERNS = [
  /\b(my\s+name|mera\s+naam|naam\s+kya|what.*name|kaun\s+hu|main\s+kaun|mera\s+pehchan)\b/i,
  /\b(who\s+am\s+i|mujhe\s+kaun\s+bolte)\b/i,
];

const PREFERENCE_PATTERNS = [
  /\b(prefer|favorite|like|dislike|choose|pasand|pasand\s+nahi|favorite|pref|setting|style|theme|color)\b/i,
];

const RELATIONSHIP_PATTERNS = [
  /\b(friend|family|know|met|person|guy|girl|aur|kaun|kiska|kiska|relationship|bond)\b/i,
  /\b([A-Z][a-z]{2,}(\s+[A-Z][a-z]{2,})?)\s+(friend|brother|sister|mother|father|person|guy|girl)/i,
];

const PROJECT_PATTERNS = [
  /\b(project|build|work|develop|create|making|task|goal|kiara|app|website|product|feature|par\s+kaam)\b/i,
];

const TEMPORAL_PATTERNS = {
  today: /\b(today|aaj|this\s+morning|is\s+morning|kal\s+morning|just\s+now|right\s+now|ek\s+dum|abhi)\b/i,
  yesterday: /\b(yesterday|kal|last\s+night|raat\s+ko|pichle\s+kal|ek\s+din\s+pehle)\b/i,
  thisWeek: /\b(this\s+week|is\s+hafta|pichle\s+kuch\s+din)\b/i,
  lastWeek: /\b(last\s+week|pichla\s+hafta|one\s+week\s+ago|week\s+pehle)\b/i,
  thisMonth: /\b(this\s+month|is\s+month|this\s+mahine)\b/i,
  lastMonth: /\b(last\s+month|pichla\s+month|mahine\s+pehle)\b/i,
};

const RECALL_REFERENCE_PATTERNS = [
  /\b(that|it|it's|the|which|what)\s+(thing|topic|subject|project|person|idea|story|thing|event|memory)\b/i,
  /\b(what\s+did|kya\s+tha|tha\s+kya|yaad\s+hai|aur\s+kya|tab\s+kya|phir\s+kya|fir|then|what\s+happened|kya\s+hua)\b/i,
  /\b(continue|aage|agle|phir\s+kya|then\s+what|further)\b/i,
];

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Extract proper nouns (potential entity names) from text.
 * Simple heuristic: capitalized words that aren't at sentence start.
 */
function extractProperNouns(text) {
  if (!text) return [];
  
  // Match capitalized words (at least 2 chars)
  const matches = text.match(/\b[A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,})?\b/g) || [];
  
  // Deduplicate and filter
  const entities = Array.from(new Set(matches));
  return entities.filter(e => {
    // Exclude common words
    const lower = e.toLowerCase();
    const excluded = ['the', 'a', 'an', 'is', 'are', 'be', 'user', 'kiara'];
    return !excluded.includes(lower);
  });
}

/**
 * Extract simple keywords from text (words > 4 chars, excluding common)
 */
function extractKeywords(text) {
  if (!text) return [];
  
  const common = new Set([
    'what', 'when', 'where', 'why', 'how', 'tell', 'show', 'know', 
    'think', 'about', 'would', 'could', 'should', 'please', 'thanks',
    'remember', 'forgot', 'tell', 'ask', 'tell', 'hello', 'hi', 'hey',
  ]);
  
  const words = text.toLowerCase().match(/\b\w{4,}\b/g) || [];
  return Array.from(new Set(words)).filter(w => !common.has(w)).slice(0, 10);
}

/**
 * Detect intent type from query.
 */
function detectIntent(text) {
  if (!text) return 'semantic_search';
  
  const lower = text.toLowerCase();
  
  // Identity recall
  if (IDENTITY_PATTERNS.some(p => p.test(text))) {
    return 'identity_recall';
  }
  
  // Preference query
  if (PREFERENCE_PATTERNS.some(p => p.test(text))) {
    return 'preference_query';
  }
  
  // Relationship query
  if (RELATIONSHIP_PATTERNS.some(p => p.test(text))) {
    return 'relationship_query';
  }
  
  // Project/goal query
  if (PROJECT_PATTERNS.some(p => p.test(text))) {
    return 'project_query';
  }
  
  // Recall reference ("what did I", "continue", "that thing")
  if (RECALL_REFERENCE_PATTERNS.some(p => p.test(text))) {
    return 'recall_reference';
  }
  
  // Temporal recall
  if (Object.values(TEMPORAL_PATTERNS).some(p => p.test(text))) {
    return 'temporal_recall';
  }
  
  // Default semantic search
  return 'semantic_search';
}

/**
 * Detect temporal hints in query.
 */
function detectTemporalHint(text) {
  if (!text) return null;
  
  for (const [period, pattern] of Object.entries(TEMPORAL_PATTERNS)) {
    if (pattern.test(text)) {
      return period;
    }
  }
  
  return null;
}

/**
 * Check if query contains conversational reference.
 */
function hasConversationalReference(text) {
  if (!text) return false;
  return RECALL_REFERENCE_PATTERNS.some(p => p.test(text));
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Analyze user query and return structured query representation.
 * 
 * @param {string} text - user query
 * @returns {Object} {
 *   intent: string,
 *   entities: string[],
 *   keywords: string[],
 *   temporalHint: string|null,
 *   hasConversationalReference: boolean,
 *   shouldSearchShortTerm: boolean,
 *   shouldSearchLongTerm: boolean,
 *   shouldSearchDeep: boolean,
 * }
 */
function analyzeQuery(text, sessionContext = {}) {
  const startAt = Date.now();
  const activeContext = sessionContext.activeContext || {};
  const activeEntities = Array.isArray(activeContext.activeEntities) ? activeContext.activeEntities : [];
  const lastReferencedEntity = activeContext.lastReferencedEntity || null;
  
  if (!text || !String(text).trim()) {
    return {
      intent: 'empty',
      entities: [...new Set(activeEntities.filter(Boolean).concat(lastReferencedEntity ? [lastReferencedEntity] : []))],
      keywords: [],
      temporalHint: null,
      hasConversationalReference: false,
      shouldSearchShortTerm: true,
      shouldSearchLongTerm: false,
      shouldSearchDeep: false,
    };
  }
  
  const lowerText = String(text).toLowerCase();
  const pronounBoost = /(\b(it|that|this|they|them|those|these|the project|the app|the backend|the previous one|why|what about that)\b)/i.test(lowerText);
  const intent = detectIntent(text);
  const extractedEntities = extractProperNouns(text);
  const sessionEntities = [...new Set([...(activeEntities || []), ...(lastReferencedEntity ? [lastReferencedEntity] : [])].filter(Boolean))];
  const entities = [...new Set(extractedEntities.concat(pronounBoost ? sessionEntities : []))];
  const keywords = extractKeywords(text);
  const temporalHint = detectTemporalHint(text);
  const isConversationalRef = hasConversationalReference(text) || pronounBoost;
  
  // Escalation logic: which levels to search?
  let shouldSearchShortTerm = true;
  let shouldSearchLongTerm = false;
  let shouldSearchDeep = false;
  
  // Identity/preference/relationship queries should definitely search LTM
  if (['identity_recall', 'preference_query', 'relationship_query'].includes(intent)) {
    shouldSearchLongTerm = true;
  }
  
  // Project queries should search LTM
  if (intent === 'project_query') {
    shouldSearchLongTerm = true;
  }
  
  // Recall references should search LTM (and possibly deep if not found in LTM)
  if (intent === 'recall_reference') {
    shouldSearchLongTerm = true;
  }
  
  // Temporal recall: if asking about past events, search LTM
  if (intent === 'temporal_recall') {
    shouldSearchLongTerm = true;
    // If asking about very old events, escalate to deep
    if (temporalHint && ['lastMonth', 'older'].includes(temporalHint)) {
      shouldSearchDeep = true;
    }
  }
  
  // Semantic search: try LTM if we have good signals
  if (intent === 'semantic_search' && (entities.length > 0 || keywords.length > 2)) {
    shouldSearchLongTerm = true;
  }
  
  logger.log('QUERY_ANALYSIS', {
    intent,
    entities: entities.length,
    keywords: keywords.length,
    temporalHint,
    hasConversationalRef: isConversationalRef,
    shouldSearchSTM: shouldSearchShortTerm,
    shouldSearchLTM: shouldSearchLongTerm,
    shouldSearchDeep: shouldSearchDeep,
    durationMs: Date.now() - startAt,
  });
  
  return {
    intent,
    entities,
    keywords,
    temporalHint,
    hasConversationalReference: isConversationalRef,
    shouldSearchShortTerm,
    shouldSearchLongTerm,
    shouldSearchDeep,
  };
}

module.exports = { analyzeQuery, detectIntent, extractProperNouns, extractKeywords, detectTemporalHint };
