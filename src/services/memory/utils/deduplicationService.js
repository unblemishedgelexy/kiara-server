'use strict';

/**
 * Memory Deduplication Service
 * 
 * Detects and handles duplicate memories to maintain a clean, single-source-of-truth knowledge base.
 * Uses both semantic identity and content fingerprinting.
 */

const memoryIdentity = require('./memoryIdentity');
const logger = require('./memoryLogger');

// ────────────────────────────────────────────────────────────────────
// Deduplication Logic
// ────────────────────────────────────────────────────────────────────

/**
 * Check if a candidate memory is a duplicate of existing memory.
 * 
 * @param {Object} candidate - new memory to check
 * @param {Object[]} existingMemories - array of existing memories
 * @param {Object} options
 * @returns {Object} { isDuplicate: boolean, matchedId: string|null, matchType: string|null }
 */
function checkForDuplicates(candidate, existingMemories, options = {}) {
  if (!candidate || !Array.isArray(existingMemories) || existingMemories.length === 0) {
    return { isDuplicate: false, matchedId: null, matchType: null };
  }
  
  const IDENTITY_SIMILARITY_THRESHOLD = 0.7;
  const CONTENT_FINGERPRINT_MATCH = true;
  
  // Generate candidate identity
  const candidateId = memoryIdentity.generateMemoryIdentity(candidate);
  const candidateFp = memoryIdentity.generateFingerprint(candidate.content || candidate.value || '');
  
  logger.log('DEDUP_CHECK_START', {
    candidateId,
    candidateFp: candidateFp.slice(0, 16),
    existingCount: existingMemories.length,
  });
  
  for (const existing of existingMemories) {
    // Skip inactive/obsolete memories
    if (existing.active === false || existing.obsolete === true) {
      continue;
    }
    
    const existingId = existing.identity || memoryIdentity.generateMemoryIdentity(existing);
    const existingFp = existing.fingerprint || memoryIdentity.generateFingerprint(existing.content || existing.value || '');
    
    // 1. Identity-based match (strongest signal)
    if (candidateId && existingId) {
      const similarity = memoryIdentity.calculateIdentitySimilarity(candidateId, existingId);
      if (similarity >= IDENTITY_SIMILARITY_THRESHOLD) {
        logger.log('DEDUP_MATCH_IDENTITY', {
          candidateId,
          existingId,
          similarity,
        });
        return {
          isDuplicate: true,
          matchedId: existing.id || existing._id || existing.memoryId,
          matchType: 'identity',
          similarity,
        };
      }
    }
    
    // 2. Content fingerprint match (confirms semantic similarity)
    if (candidateFp && existingFp && memoryIdentity.fingerprintsMatch(candidateFp, existingFp)) {
      logger.log('DEDUP_MATCH_FINGERPRINT', {
        candidateId,
        existingId,
        candidateFp: candidateFp.slice(0, 16),
        existingFp: existingFp.slice(0, 16),
      });
      return {
        isDuplicate: true,
        matchedId: existing.id || existing._id || existing.memoryId,
        matchType: 'fingerprint',
        similarity: 1.0,
      };
    }
    
    // 3. Text similarity check (if both have content)
    const candidateText = String(candidate.content || candidate.value || candidate.summary || '').toLowerCase().slice(0, 200);
    const existingText = String(existing.content || existing.value || existing.summary || '').toLowerCase().slice(0, 200);
    
    if (candidateText && existingText && candidateText === existingText) {
      logger.log('DEDUP_MATCH_TEXT', {
        candidateId,
        existingId,
      });
      return {
        isDuplicate: true,
        matchedId: existing.id || existing._id || existing.memoryId,
        matchType: 'exact_text',
        similarity: 1.0,
      };
    }
  }
  
  logger.log('DEDUP_NO_MATCH', { candidateId, candidateFp: candidateFp.slice(0, 16) });
  return { isDuplicate: false, matchedId: null, matchType: null };
}

/**
 * Prepare duplicate resolution action.
 * Returns object describing what to do with duplicates.
 */
function resolveDuplicate(candidateMemory, existingMatchId, matchType) {
  return {
    action: 'update_existing',
    existingMemoryId: existingMatchId,
    candidateMemory,
    matchType,
    updateFields: {
      // Update last accessed time
      lastAccessed: new Date().toISOString(),
      
      // Increment access count
      accessCount: (candidateMemory.accessCount || 0) + 1,
      
      // Mark candidate as superseded if it's a new version
      obsolete: true,
      supersededBy: existingMatchId,
      
      // Update value if candidate is newer/better
      ...(candidateMemory.importance && candidateMemory.importance > (candidateMemory.importance || 0) && {
        value: candidateMemory.value || candidateMemory.content,
        importance: candidateMemory.importance,
      }),
    },
  };
}

/**
 * Filter out duplicates from a list of memories.
 * Keeps the "best" version of each unique memory.
 */
function deduplicateMemoryList(memories) {
  if (!Array.isArray(memories) || memories.length === 0) {
    return memories;
  }
  
  const seen = new Map(); // Maps identity -> best memory
  const result = [];
  
  for (const memory of memories) {
    const id = memory.identity || memoryIdentity.generateMemoryIdentity(memory);
    const fp = memory.fingerprint || memoryIdentity.generateFingerprint(memory.content || memory.value || '');
    
    const key = id || fp; // Fallback to fingerprint if no identity
    
    if (!key) {
      result.push(memory);
      continue;
    }
    
    if (!seen.has(key)) {
      seen.set(key, memory);
      result.push(memory);
    } else {
      // Compare: keep the one with higher importance/confidence
      const existing = seen.get(key);
      const shouldKeepCandidate = (memory.importance || 0) > (existing.importance || 0) ||
                                  (memory.confidence || 0) > (existing.confidence || 0);
      
      if (shouldKeepCandidate) {
        // Replace existing with this one
        const idx = result.indexOf(existing);
        if (idx >= 0) {
          result[idx] = memory;
          seen.set(key, memory);
        }
      }
    }
  }
  
  logger.log('MEMORY_DEDUP_FILTERED', {
    originalCount: memories.length,
    deduplicatedCount: result.length,
    duplicatesRemoved: memories.length - result.length,
  });
  
  return result;
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

module.exports = {
  checkForDuplicates,
  resolveDuplicate,
  deduplicateMemoryList,
};
