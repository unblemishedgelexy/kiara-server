'use strict';

/**
 * Memory Relevance Ranking Service
 * 
 * Ranks memories by multi-factor relevance scoring.
 * Factors:
 *   - semantic similarity (vector match)
 *   - entity match (does memory mention query entities?)
 *   - keyword match (do memory keywords overlap with query?)
 *   - identity match (does memory's identity match query?)
 *   - recency (how recent is the memory?)
 *   - importance (how important is the memory?)
 *   - confidence (how confident are we in this memory?)
 *   - conversation continuity (is this related to current topic?)
 */

const logger = require('./memoryLogger');

// ────────────────────────────────────────────────────────────────────
// Scoring Functions
// ────────────────────────────────────────────────────────────────────

/**
 * Calculate semantic similarity score (0-1).
 * Uses vector similarity if available, otherwise returns provided score.
 */
function scoreSemanticSimilarity(memory, queryEmbedding, vectorScore) {
  const score = Number(vectorScore || memory.semanticScore || memory.score || 0);
  return Math.min(1, Math.max(0, score));
}

/**
 * Calculate entity match score (0-1).
 * Higher if memory mentions entities from query.
 */
function scoreEntityMatch(memory, queryEntities) {
  if (!Array.isArray(queryEntities) || queryEntities.length === 0) {
    return 0;
  }
  
  const memoryEntities = Array.isArray(memory.entities) ? memory.entities : 
                        (memory.metadata?.entities || []);
  
  if (memoryEntities.length === 0) {
    return 0;
  }
  
  let matches = 0;
  for (const qEntity of queryEntities) {
    if (memoryEntities.some(mE => String(mE).toLowerCase() === String(qEntity).toLowerCase())) {
      matches += 1;
    }
  }
  
  return Math.min(1, matches / queryEntities.length);
}

/**
 * Calculate keyword match score (0-1).
 * Higher if memory shares keywords with query.
 */
function scoreKeywordMatch(memory, queryKeywords) {
  if (!Array.isArray(queryKeywords) || queryKeywords.length === 0) {
    return 0;
  }
  
  const memoryKeywords = Array.isArray(memory.keywords) ? memory.keywords : 
                        (memory.metadata?.keywords || []);
  
  if (memoryKeywords.length === 0) {
    return 0;
  }
  
  let matches = 0;
  for (const qKeyword of queryKeywords) {
    if (memoryKeywords.some(mK => String(mK).toLowerCase().includes(String(qKeyword).toLowerCase()))) {
      matches += 1;
    }
  }
  
  return Math.min(1, matches / queryKeywords.length);
}

/**
 * Calculate identity match score (0-1).
 * Higher if memory's identity category matches query intent.
 */
function scoreIdentityMatch(memory, queryIntent) {
  const memoryType = memory.type || memory.category || 'fact';
  
  // Map intent to expected memory type
  const intentToType = {
    identity_recall: 'identity',
    preference_query: 'preference',
    relationship_query: 'person',
    project_query: 'project',
    temporal_recall: 'event',
    recall_reference: 'episode',
  };
  
  const expectedType = intentToType[queryIntent] || null;
  
  if (!expectedType) return 0;
  
  return memoryType.toLowerCase() === expectedType.toLowerCase() ? 1.0 : 0.2;
}

/**
 * Calculate recency score (0-1).
 * Decay over time: recent memories score higher.
 */
function scoreRecency(memory, currentTime) {
  const timestamp = memory.metadata?.updatedAt || 
                   memory.metadata?.createdAt || 
                   memory.updatedAt || 
                   memory.createdAt || 
                   null;
  
  if (!timestamp) return 0.5; // Neutral if no timestamp
  
  try {
    const memoryTime = new Date(String(timestamp)).getTime();
    const now = currentTime || Date.now();
    const ageMs = Math.max(0, now - memoryTime);
    
    // Decay function: full score within 1 day, gradual decay over 90 days
    const dayMs = 24 * 60 * 60 * 1000;
    const maxAge = 90 * dayMs;
    
    if (ageMs < dayMs) return 1.0;
    if (ageMs > maxAge) return 0.1;
    
    return Math.max(0.1, 1.0 - (ageMs / maxAge) * 0.9);
  } catch (_) {
    return 0.5;
  }
}

/**
 * Calculate importance score (0-1).
 * Uses memory's importance field directly.
 */
function scoreImportance(memory) {
  const importance = Number(memory.importance || 0);
  return Math.min(1, Math.max(0, importance));
}

/**
 * Calculate confidence score (0-1).
 * Uses memory's confidence field directly.
 */
function scoreConfidence(memory) {
  const confidence = Number(memory.confidence || 0.5);
  return Math.min(1, Math.max(0, confidence));
}

/**
 * Calculate temporal hint match (0-1).
 * Higher if memory's timestamp matches query's temporal hint.
 */
function scoreTemporalHint(memory, temporalHint) {
  if (!temporalHint) return 0.5; // Neutral if no temporal hint
  
  const timestamp = memory.metadata?.updatedAt || memory.metadata?.createdAt || memory.updatedAt || memory.createdAt;
  if (!timestamp) return 0.3;
  
  try {
    const memoryTime = new Date(String(timestamp));
    const now = new Date();
    const ageMs = now.getTime() - memoryTime.getTime();
    const dayMs = 24 * 60 * 60 * 1000;
    
    switch (temporalHint) {
      case 'today':
        return ageMs < dayMs ? 1.0 : 0.2;
      case 'yesterday':
        return ageMs >= dayMs && ageMs < 2 * dayMs ? 1.0 : 0.2;
      case 'thisWeek':
        return ageMs < 7 * dayMs ? 1.0 : 0.2;
      case 'lastWeek':
        return ageMs >= 7 * dayMs && ageMs < 14 * dayMs ? 1.0 : 0.2;
      case 'thisMonth':
        return ageMs < 30 * dayMs ? 1.0 : 0.2;
      case 'lastMonth':
        return ageMs >= 30 * dayMs && ageMs < 60 * dayMs ? 1.0 : 0.2;
      default:
        return 0.5;
    }
  } catch (_) {
    return 0.3;
  }
}

/**
 * Calculate access frequency score (0-1).
 * Higher if memory has been accessed frequently.
 */
function scoreAccessFrequency(memory) {
  const accessCount = Number(memory.accessCount || 0);
  
  // Logarithmic scale: more accesses = higher score, but diminishing returns
  // 0 accesses = 0, 1 access = 0.3, 10 accesses = 0.7, 100+ = 0.95
  return Math.min(0.95, Math.log(1 + accessCount) / Math.log(100));
}

// ────────────────────────────────────────────────────────────────────
// Weighted Ranking
// ────────────────────────────────────────────────────────────────────

/**
 * Calculate composite relevance score (0-1).
 * Combines all factors with weights.
 */
function calculateRelevanceScore(memory, query, weights = {}) {
  const defaultWeights = {
    semantic: 0.30,
    entity: 0.15,
    keyword: 0.15,
    identity: 0.10,
    recency: 0.10,
    importance: 0.10,
    confidence: 0.05,
    temporal: 0.05,
  };
  
  const finalWeights = { ...defaultWeights, ...weights };
  
  // Normalize weights to sum to 1.0
  const totalWeight = Object.values(finalWeights).reduce((s, w) => s + (Number(w) || 0), 0) || 1;
  for (const key of Object.keys(finalWeights)) {
    finalWeights[key] = (Number(finalWeights[key]) || 0) / totalWeight;
  }
  
  // Calculate individual scores
  const scores = {
    semantic: scoreSemanticSimilarity(memory, query.embedding, memory.score),
    entity: scoreEntityMatch(memory, query.entities),
    keyword: scoreKeywordMatch(memory, query.keywords),
    identity: scoreIdentityMatch(memory, query.intent),
    recency: scoreRecency(memory),
    importance: scoreImportance(memory),
    confidence: scoreConfidence(memory),
    temporal: scoreTemporalHint(memory, query.temporalHint),
  };
  
  // Weighted sum
  let compositeScore = 0;
  for (const [factor, score] of Object.entries(scores)) {
    compositeScore += score * (finalWeights[factor] || 0);
  }
  
  return {
    compositeScore: Math.min(1, Math.max(0, compositeScore)),
    factors: scores,
    weights: finalWeights,
  };
}

/**
 * Rank memories by relevance to query.
 */
function rankMemories(memories, query, weights = {}) {
  if (!Array.isArray(memories) || memories.length === 0) {
    return [];
  }
  
  const startAt = Date.now();
  
  // Score each memory
  const scored = memories.map(memory => {
    const relevance = calculateRelevanceScore(memory, query, weights);
    return {
      ...memory,
      relevanceScore: relevance.compositeScore,
      relevanceFactors: relevance.factors,
    };
  });
  
  // Sort by relevance score (descending)
  scored.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
  
  const durationMs = Date.now() - startAt;
  logger.log('MEMORY_RANKING', {
    inputCount: memories.length,
    outputCount: scored.length,
    topScore: scored[0]?.relevanceScore || 0,
    durationMs,
  });
  
  return scored;
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

module.exports = {
  // Individual scoring functions
  scoreSemanticSimilarity,
  scoreEntityMatch,
  scoreKeywordMatch,
  scoreIdentityMatch,
  scoreRecency,
  scoreImportance,
  scoreConfidence,
  scoreTemporalHint,
  scoreAccessFrequency,
  
  // Composite scoring and ranking
  calculateRelevanceScore,
  rankMemories,
};
