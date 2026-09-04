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
  /\b(my\s+name|mera\s+naam|naam\s+kya|what.*name|mera\s+pehchan)\b/i,
  /\b(who\s+am\s+i|mujhe\s+kaun\s+bolte|kaun\s+hu\s+main|main\s+kaun\s+hu)\b/i,
  // Stricter: only match "kaun hu" or "mujhe kaun bolte" (who am I), not generic "kaun"
];

const PREFERENCE_PATTERNS = [
  /\b(prefer|favorite|pasand|pasand\s+nahi|like|dislike|choose|pref|setting|style|theme|color|food|drink|music|movie|genre|taste)\b/i,
  // Check for explicit preference context: "X pasand hai" or "favorite X" or "X color/style"
  /\b(kaun\s+sa|kaun\s+se|kaun\s+si)(\s+\w+)?\s+(pasand|favorite|color|food|drink|music)\b/i,
];

const RELATIONSHIP_PATTERNS = [
  /\b(friend|family|met|person|guy|girl|relationship|bond|brother|sister|mother|father)\b/i,
  /\b([A-Z][a-z]{2,}(\s+[A-Z][a-z]{2,})?)\s+(friend|brother|sister|mother|father|person|guy|girl)/i,
  // Don't include generic "kaun" or "kiska" - too broad
];

const PROJECT_PATTERNS = [
  /\b(project|build|work|develop|create|making|task|kiara|app|website|product|feature|par\s+kaam|building|building)\b/i,
];

const GOAL_PATTERNS = [
  /\b(goal|target|objective|plan|banana\s+hai|banna\s+hai|karna\s+hai|krna\s+hai|improve|perfect|aim|ambition|dream|banna\s+chu)\b/i,
  // Explicit goal markers: "mera goal", "ek startup banana hai"
  /\b(mera\s+goal|tera\s+goal|goal\s+kya|startup|company|business|entrepreneur)\b/i,
];

const SKILL_PATTERNS = [
  // SKILL: Focus on building capability, NOT just general learning
  /\b(skill|coding|programming|development|design|writing|speaking|technical|expertise|good\s+at)\b/i,
  // Explicit skill context markers
  /\b(tum\s+kya\s+skill|skill\s+seekh|coding\s+karna|programming\s+karna)\b/i,
];

const FACT_PATTERNS = [
  // FACT: Information, subject matter, study topics, NOT skill-building
  /\b(fact|know|knowledge|information|study|course|subject|topic|learning|studying|doing|learned|doing)\b/i,
  // Explicit learning context: "padh raha hoon" = studying, "seekh raha hoon" = learning
  /\b(padh\s+raha|padh\s+rahe|seekh\s+raha|seekh\s+rahe|studying|learning|course|subject|topic|material)\b/i,
  // Educational content markers
  /\b(AI|ML|python|javascript|database|web|mobile|data|science|engineering|mathematics|physics|chemistry)\b/i,
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

const FORGET_PATTERNS = [
  /\b(forget|remove|delete|clear|discard|dismiss|forget\s+that|bhool|jao|mita|mita|yaad\s+mat\s+rakhna|mat\s+rakhna|bhool\s+jao|delete\s+this|remove\s+this)\b/i,
  /\b(?:forget|delete|remove|bhool|mita|clear)\s+(?:that|this|my|mera|meri|mujhe|ye|is)\b/i,
  /\b(?:yaad\s+mat\s+rakhna|mat\s+rakhna|memory\s+delete\s+kar|memory\s+remove|bhool\s+jao)\b/i,
];

const QUERY_SYNONYMS = new Map([
  ['fav', 'favorite'], ['favourite', 'favorite'], ['preferred', 'favorite'], ['choice', 'favorite'],
  ['pasand', 'favorite'], ['like', 'favorite'],
  ['aim', 'goal'], ['target', 'goal'], ['objective', 'goal'], ['ambition', 'goal'], ['dream', 'goal'],
  ['seekh', 'skill'], ['learn', 'skill'], ['learned', 'skill'], ['capability', 'skill'], ['expertise', 'skill'],
  ['build', 'project'], ['building', 'project'], ['develop', 'project'], ['development', 'project'],
  ['person', 'relationship'], ['people', 'relationship'], ['family', 'relationship'],
]);

const ATTRIBUTE_ALIASES = [
  { pattern: /(?:favorite|preferred|pasand|like|choice)\s+(?:ka|ki|ke|my|your)?\s*(color|colour)/i, attribute: 'favorite_color' },
  { pattern: /(?:color|colour)\s+(?:do\s+i\s+)?(?:like|prefer|pasand|favorite)|(?:kaunsa|kaun\s+sa|kaunsi)\s+(?:color|colour)/i, attribute: 'favorite_color' },
  { pattern: /(?:favorite|preferred|pasand|like|choice)\s+(?:ka|ki|ke|my|your)?\s*(book|food|drink|movie|song|music)/i, attribute: 'favorite_item' },
  { pattern: /(?:which|what|kaunsa|kaun\s+sa|kaunsi)\s+(book|food|drink|movie|song|music)/i, attribute: 'favorite_item' },
  { pattern: /(?:primary|main|mera|my)?\s*(goal|target|objective|aim)/i, attribute: 'primary_goal' },
  { pattern: /(?:programming|coding|technical|main|my)?\s*(skill|skills|expertise)/i, attribute: 'skill' },
  { pattern: /(?:my|mera|meri)?\s*(name|naam)/i, attribute: 'name' },
];

function normalizeQueryTokens(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9\u0900-\u097f]+/gi) || [];
}

function buildQueryProfile(text, intent) {
  const tokens = normalizeQueryTokens(text);
  const normalizedTokens = tokens.map((token) => QUERY_SYNONYMS.get(token) || token);
  const categoryByIntent = {
    identity_recall: 'identity', preference_query: 'preference', goal_query: 'goal', skill_query: 'skill',
    fact_query: 'fact', project_query: 'project', relationship_query: 'relationship',
  };
  const attribute = ATTRIBUTE_ALIASES.find(({ pattern }) => pattern.test(String(text || '')))?.attribute || null;
  return {
    category: categoryByIntent[intent] || null,
    attribute,
    tokens,
    normalizedTokens: [...new Set(normalizedTokens)],
  };
}

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
  
  // ==================== PRIORITY ORDER ====================
  // Most specific patterns first, broadest last to avoid overlaps

  // 0. DELETE / FORGET REQUESTS - must trigger before recall/ preference queries
  if (FORGET_PATTERNS.some(p => p.test(text))) {
    return 'memory_delete';
  }
  
  // 1. IDENTITY RECALL - Highest priority, very specific
  //    Patterns: "mera naam", "my name", "who am i"
  if (IDENTITY_PATTERNS.some(p => p.test(text))) {
    return 'identity_recall';
  }
  
  // 2. PROJECT QUERY - Check before goal/skill
  if (PROJECT_PATTERNS.some(p => p.test(text))) {
    return 'project_query';
  }
  
  // 3. GOAL QUERY - Very specific: "goal", "startup", "banana hai"
  if (GOAL_PATTERNS.some(p => p.test(text))) {
    return 'goal_query';
  }
  
  // 4. PREFERENCE QUERY - Explicit preference markers
  //    Must check BEFORE relationship to avoid "kaun" overlap
  //    Patterns: "pasand hai", "favorite", "color", "food"
  if (PREFERENCE_PATTERNS.some(p => p.test(text))) {
    return 'preference_query';
  }
  
  // 5. SKILL QUERY - Explicit skill building
  //    Patterns: "skill seekh", "coding karna", "expertise"
  //    Must check BEFORE fact to avoid "learn/seekh" overlap
  if (SKILL_PATTERNS.some(p => p.test(text))) {
    return 'skill_query';
  }
  
  // 6. FACT QUERY - Information, topics, studies
  //    Patterns: "padh raha hoon", "studying", "AI/ML", "course"
  //    Last before relationship to catch remaining academic content
  if (FACT_PATTERNS.some(p => p.test(text))) {
    return 'fact_query';
  }
  
  // 7. RELATIONSHIP QUERY - Check after preference to avoid overlaps
  if (RELATIONSHIP_PATTERNS.some(p => p.test(text))) {
    return 'relationship_query';
  }
  
  // 8. RECALL REFERENCE - Conversational references
  if (RECALL_REFERENCE_PATTERNS.some(p => p.test(text))) {
    return 'recall_reference';
  }
  
  // 9. TEMPORAL RECALL - Time-based queries
  if (Object.values(TEMPORAL_PATTERNS).some(p => p.test(text))) {
    return 'temporal_recall';
  }
  
  // Default fallback
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
  const queryProfile = buildQueryProfile(text, intent);
  
  // Escalation logic: which levels to search?
  let shouldSearchShortTerm = true;
  let shouldSearchLongTerm = false;
  let shouldSearchDeep = false;
  
  // Identity/preference/relationship/goal/skill/fact queries should search LTM
  if ([
    'identity_recall', 
    'preference_query', 
    'relationship_query',
    'goal_query',
    'skill_query',
    'fact_query'
  ].includes(intent)) {
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
    queryProfile,
    queryProfile,
  };
}

module.exports = { analyzeQuery, detectIntent, extractProperNouns, extractKeywords, detectTemporalHint, buildQueryProfile, normalizeQueryTokens };
