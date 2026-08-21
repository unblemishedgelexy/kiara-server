'use strict';

/**
 * Memory Identity Service
 * 
 * Generates stable, meaningful identity keys for memories.
 * Enables deduplication, stable indexing, and intelligent retrieval.
 * 
 * Identity Structure:
 *   {type}.{category}.{key}
 * 
 * Examples:
 *   identity.name.primary
 *   identity.email.primary
 *   preference.ui.framework
 *   project.kiara.active
 *   person.abhay.friend
 *   relationship.work.kiara-team
 *   event.interview.coa-2024
 *   technology.react.stack
 */

const logger = require('./memoryLogger');

// ────────────────────────────────────────────────────────────────────
// Identity Type Definitions
// ────────────────────────────────────────────────────────────────────

const IDENTITY_TYPES = {
  // User facts
  IDENTITY: 'identity',
  PREFERENCE: 'preference',
  TECHNOLOGY: 'technology',
  SKILL: 'skill',
  GOAL: 'goal',
  
  // Relationships
  PERSON: 'person',
  RELATIONSHIP: 'relationship',
  ORGANIZATION: 'organization',
  
  // Projects & Work
  PROJECT: 'project',
  TASK: 'task',
  ACHIEVEMENT: 'achievement',
  
  // Events & Timeline
  EVENT: 'event',
  EPISODE: 'episode',
  
  // Knowledge
  FACT: 'fact',
  CONCEPT: 'concept',
};

// ────────────────────────────────────────────────────────────────────
// Category Definitions by Type
// ────────────────────────────────────────────────────────────────────

const CATEGORIES_BY_TYPE = {
  [IDENTITY_TYPES.IDENTITY]: ['name', 'email', 'age', 'location', 'native_language', 'timezone'],
  [IDENTITY_TYPES.PREFERENCE]: ['ui', 'communication', 'coding', 'learning', 'social', 'food', 'music', 'entertainment'],
  [IDENTITY_TYPES.TECHNOLOGY]: ['language', 'framework', 'tool', 'platform', 'database', 'methodology'],
  [IDENTITY_TYPES.SKILL]: ['technical', 'soft', 'leadership', 'creative', 'analytical'],
  [IDENTITY_TYPES.GOAL]: ['short_term', 'long_term', 'current', 'aspiration'],
  [IDENTITY_TYPES.PERSON]: ['friend', 'colleague', 'family', 'mentor', 'contact'],
  [IDENTITY_TYPES.RELATIONSHIP]: ['friend', 'colleague', 'mentorship', 'partnership', 'family'],
  [IDENTITY_TYPES.ORGANIZATION]: ['company', 'startup', 'community', 'team'],
  [IDENTITY_TYPES.PROJECT]: ['active', 'completed', 'personal', 'professional', 'learning'],
  [IDENTITY_TYPES.TASK]: ['in_progress', 'pending', 'completed', 'blocked'],
  [IDENTITY_TYPES.ACHIEVEMENT]: ['personal', 'professional', 'learning', 'social'],
  [IDENTITY_TYPES.EVENT]: ['personal', 'professional', 'celebration', 'challenge'],
  [IDENTITY_TYPES.EPISODE]: ['conversation', 'interaction', 'discovery', 'milestone'],
  [IDENTITY_TYPES.FACT]: ['general', 'personal', 'technical', 'reference'],
  [IDENTITY_TYPES.CONCEPT]: ['technical', 'philosophical', 'social', 'practical'],
};

// ────────────────────────────────────────────────────────────────────
// Helper Functions
// ────────────────────────────────────────────────────────────────────

/**
 * Normalize text for use in identity keys (lowercase, remove special chars).
 */
function normalizeKeyPart(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '') // Remove special chars
    .replace(/\s+/g, '_')      // Replace spaces with underscores
    .slice(0, 50);             // Limit length
}

/**
 * Generate fingerprint/hash of memory content for deduplication.
 * Uses simple approach: hash of normalized content.
 */
function generateFingerprint(content) {
  if (!content) return '';
  
  const normalized = String(content)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 500); // First 500 chars
  
  // Simple hash (not cryptographic, just for duplication detection)
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  
  return `fp_${Math.abs(hash).toString(36).padStart(8, '0')}`;
}

// ────────────────────────────────────────────────────────────────────
// Identity Generation
// ────────────────────────────────────────────────────────────────────

/**
 * Generate identity for an identity fact (user name, email, etc.)
 */
function generateIdentityMemoryId(category, value) {
  if (!category || !value) return null;
  
  const normalizedCategory = normalizeKeyPart(category);
  if (!CATEGORIES_BY_TYPE[IDENTITY_TYPES.IDENTITY].includes(normalizedCategory)) {
    return null;
  }
  
  // For identity facts, typically only one per category
  return `${IDENTITY_TYPES.IDENTITY}.${normalizedCategory}.primary`;
}

/**
 * Generate identity for a preference
 */
function generatePreferenceMemoryId(category, aspect) {
  if (!category) return null;
  
  const normalizedCategory = normalizeKeyPart(category);
  const normalizedAspect = aspect ? normalizeKeyPart(aspect) : 'default';
  
  if (!CATEGORIES_BY_TYPE[IDENTITY_TYPES.PREFERENCE].includes(normalizedCategory)) {
    return null;
  }
  
  return `${IDENTITY_TYPES.PREFERENCE}.${normalizedCategory}.${normalizedAspect}`;
}

/**
 * Generate identity for a project
 */
function generateProjectMemoryId(projectName) {
  if (!projectName) return null;
  
  const normalized = normalizeKeyPart(projectName);
  return `${IDENTITY_TYPES.PROJECT}.${normalized}.active`;
}

/**
 * Generate identity for a person/relationship
 */
function generatePersonMemoryId(personName, relationshipType = 'contact') {
  if (!personName) return null;
  
  const normalized = normalizeKeyPart(personName);
  const relType = normalizeKeyPart(relationshipType) || 'contact';
  
  return `${IDENTITY_TYPES.PERSON}.${normalized}.${relType}`;
}

/**
 * Generate identity for an event
 */
function generateEventMemoryId(eventName, date) {
  if (!eventName) return null;
  
  const normalized = normalizeKeyPart(eventName);
  const dateKey = date ? normalizeKeyPart(String(date).slice(0, 10)) : 'undated';
  
  return `${IDENTITY_TYPES.EVENT}.${normalized}.${dateKey}`;
}

/**
 * Generic identity generator: analyzes memory content and generates appropriate identity
 */
function generateMemoryIdentity(memoryData) {
  if (!memoryData) return null;

  const explicitEntity = memoryData.entity || memoryData.subject || memoryData.person || memoryData.user || '';
  const explicitAttribute = memoryData.attribute || memoryData.aspect || memoryData.key || memoryData.title || memoryData.category || '';
  const explicitValue = memoryData.value || memoryData.name || memoryData.label || memoryData.target || '';

  if (explicitEntity && explicitAttribute) {
    const entity = normalizeKeyPart(explicitEntity);
    const attribute = normalizeKeyPart(explicitAttribute);
    const value = normalizeKeyPart(explicitValue || memoryData.value || attribute);
    if (entity && attribute) {
      return `${entity}.${attribute}.${value || 'unknown'}`;
    }
  }

  const type = memoryData.type || memoryData.category || 'fact';
  const title = memoryData.title || memoryData.key || memoryData.name || '';
  const subkey = memoryData.subkey || memoryData.aspect || memoryData.value || '';
  
  if (!title) return null;
  
  // Dispatch by type
  switch (type.toLowerCase()) {
    case IDENTITY_TYPES.IDENTITY:
      return generateIdentityMemoryId(title, subkey);
    
    case IDENTITY_TYPES.PREFERENCE:
      return generatePreferenceMemoryId(title, subkey);
    
    case IDENTITY_TYPES.PROJECT:
      return generateProjectMemoryId(title);
    
    case IDENTITY_TYPES.PERSON:
      return generatePersonMemoryId(title, subkey);
    
    case IDENTITY_TYPES.EVENT:
      return generateEventMemoryId(title, memoryData.date);
    
    default:
      // Generic fallback
      const normalizedType = normalizeKeyPart(type);
      const normalizedTitle = normalizeKeyPart(title);
      const normalizedSubkey = subkey ? normalizeKeyPart(subkey) : 'default';
      return `${normalizedType}.${normalizedTitle}.${normalizedSubkey}`;
  }
}

// ────────────────────────────────────────────────────────────────────
// Identity Comparison & Deduplication
// ────────────────────────────────────────────────────────────────────

/**
 * Check if two memories represent the same identity.
 * Returns similarity score 0-1.
 */
function calculateIdentitySimilarity(id1, id2) {
  if (!id1 || !id2) return 0;
  
  if (id1 === id2) return 1.0; // Exact match
  
  // Parse identity parts
  const parts1 = String(id1).split('.');
  const parts2 = String(id2).split('.');
  
  if (parts1.length < 2 || parts2.length < 2) return 0;
  
  let matches = 0;
  let total = Math.max(parts1.length, parts2.length);
  
  // Compare type
  if (parts1[0] === parts2[0]) matches += 1;
  
  // Compare category/name
  if (parts1[1] === parts2[1]) matches += 1;
  
  // Compare subkey
  if (parts1[2] && parts2[2] && parts1[2] === parts2[2]) matches += 1;
  
  return matches / total;
}

/**
 * Check if content fingerprints match (content-based deduplication).
 */
function fingerprintsMatch(fp1, fp2) {
  if (!fp1 || !fp2) return false;
  return fp1 === fp2;
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

module.exports = {
  // Identity types and categories
  IDENTITY_TYPES,
  CATEGORIES_BY_TYPE,
  
  // Generation
  generateMemoryIdentity,
  generateIdentityMemoryId,
  generatePreferenceMemoryId,
  generateProjectMemoryId,
  generatePersonMemoryId,
  generateEventMemoryId,
  generateFingerprint,
  
  // Comparison
  calculateIdentitySimilarity,
  fingerprintsMatch,
};
