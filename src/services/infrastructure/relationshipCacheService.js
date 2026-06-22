const redisService = require('./redisService');
const memoryRetrievalService = require('../memory/memoryRetrievalService');

const RELATIONSHIP_CACHE_TTL_SECONDS = 24 * 60 * 60;

function buildRelationshipCacheKey(userId) {
  return `relationship:${userId}`;
}

function normalizeEntry(token) {
  return String(token || '').trim().replace(/\s+/g, ' ');
}

const GENERIC_PERSON_NAMES = new Set([
  'my',
  'me',
  'friend',
  'buddy',
  'someone',
  'unknown',
  'dummy',
  'example',
  'test',
  'filler',
]);

function parseRelationshipMemory(memoryText) {
  const normalized = String(memoryText || '').trim();
  const explicitMatch = normalized.match(/\b(?:relationship:\s*)?(?:my\s+)?(?:best\s+)?(?:friend|wife|husband|partner|colleague|coworker|boss|manager|mentor|mentee|family member|family|sibling|cousin|mother|father|dad|mom|uncle|aunt)\s*(?:is|named|called|who\s+is|who's|was|,)?\s*([A-Z][a-z]+(?: [A-Z][a-z]+)*)/i);
  const fallbackMatch = normalized.match(/([A-Z][a-z]+(?: [A-Z][a-z]+)*)/);
  const personNameCandidate = explicitMatch ? normalizeEntry(explicitMatch[1]) : fallbackMatch ? normalizeEntry(fallbackMatch[1]) : null;
  const personName = personNameCandidate && !GENERIC_PERSON_NAMES.has(personNameCandidate.toLowerCase()) ? personNameCandidate : null;
  const typeMatch = normalized.match(/\b(best friend|friend|family|family member|coworker|colleague|partner|project partner|boss|manager|mentor|mentee)\b/i);

  let confidence = 0;
  if (personName) {
    confidence = explicitMatch ? 0.9 : 0.6;
    if (!typeMatch && normalized.split(' ').length <= 3) {
      confidence = Math.min(confidence, 0.5);
    }
  }

  return {
    personName,
    relationshipType: typeMatch ? typeMatch[1].toLowerCase() : 'relationship',
    rawText: normalized,
    confidence,
  };
}

function summarizeRelationshipEntries(entries) {
  const summary = entries
    .slice(0, 10)
    .map((entry) => `${entry.personName || 'Someone'} is ${entry.relationshipType}`)
    .join('; ');
  return summary || 'No relationship details available yet.';
}

async function cacheRelationshipContext(userId) {
  if (!userId) return null;
  const client = await redisService.getRedisClient();
  const key = buildRelationshipCacheKey(userId);
  const memories = await memoryRetrievalService.retrieveRelationshipMemories(userId).catch(() => []);
  const entries = memories
    .map((memory) => parseRelationshipMemory(memory.memory))
    .filter((entry) => entry.personName);

  const unique = [];
  const seen = new Set();
  for (const entry of entries) {
    const signature = `${entry.personName.toLowerCase()}|${entry.relationshipType}`;
    if (!seen.has(signature)) {
      seen.add(signature);
      unique.push(entry);
    }
  }

  const grouped = {
    names: Array.from(new Set(unique.map((item) => item.personName).filter(Boolean))),
    friends: Array.from(new Set(unique.filter((item) => item.relationshipType.includes('friend')).map((item) => item.personName))),
    family: Array.from(new Set(unique.filter((item) => item.relationshipType.includes('family')).map((item) => item.personName))),
    coworkers: Array.from(new Set(unique.filter((item) => item.relationshipType.includes('coworker') || item.relationshipType.includes('colleague')).map((item) => item.personName))),
    projectPartners: Array.from(new Set(unique.filter((item) => item.relationshipType.includes('project partner') || item.relationshipType.includes('partner')).map((item) => item.personName))),
    relationshipSummary: summarizeRelationshipEntries(unique),
    entries: unique,
    updatedAt: new Date().toISOString(),
  };

  await client.set(key, JSON.stringify(grouped), { EX: RELATIONSHIP_CACHE_TTL_SECONDS });
  return grouped;
}

async function getRelationshipContext(userId) {
  if (!userId) return null;
  const client = await redisService.getRedisClient();
  const key = buildRelationshipCacheKey(userId);
  const raw = await client.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function deleteRelationshipContext(userId) {
  if (!userId) return false;
  const client = await redisService.getRedisClient();
  const key = buildRelationshipCacheKey(userId);
  const result = await client.del(key);
  return result > 0;
}

module.exports = { cacheRelationshipContext, getRelationshipContext, deleteRelationshipContext, parseRelationshipMemory };
