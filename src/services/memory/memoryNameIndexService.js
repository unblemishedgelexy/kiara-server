const MemoryNameIndex = require('../../models/MemoryNameIndex');

function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').replace(/[^\w\s]/g, '').toLowerCase();
}

function extractPersonNames(memoryText) {
  const text = String(memoryText || '').trim();

  const relationshipPattern = text.match(/\bRelationship:\s*(?:my\s+)?(?:best\s+)?(?:friend|wife|husband|partner|colleague|coworker|boss|manager|mentor|mentee|family(?: member)?|sibling|uncle|aunt|father|mother)\s*(?:is|named|called|who\s+is|who's|was|,)\s*([A-Z][a-z]+(?: [A-Z][a-z]+)*)/i);
  if (relationshipPattern) return [relationshipPattern[1].trim()];

  const identityName = text.match(/\b(?:User name is|My name is|I am|I'm)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)*)/i);
  if (identityName) return [identityName[1].trim()];

  const projectNames = text.match(/\b(?:with|and|partner|teammate)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)*)\b/i);
  if (projectNames) return [projectNames[1].trim()];

  const fallback = text.match(/([A-Z][a-z]+(?: [A-Z][a-z]+)*)/g);
  if (!fallback) return [];

  const stopWords = new Set(['My', 'I', 'The', 'Best', 'Friend', 'Relationship', 'Is', 'Aman', 'With', 'And', 'Partner', 'Teammate']);
  return Array.from(new Set(
    fallback
      .map((name) => name.trim())
      .filter((name) => name.length > 1 && !stopWords.has(name))
  ));
}

function deriveRelationshipType(category, memoryText) {
  if (category === 'identity') return 'identity';
  if (category === 'relationship' || category === 'relationships') {
    const normalized = String(memoryText || '').toLowerCase();
    if (normalized.includes('best friend')) return 'best friend';
    if (normalized.includes('family') || normalized.includes('wife') || normalized.includes('husband') || normalized.includes('parent') || normalized.includes('mother') || normalized.includes('father')) return 'family';
    if (normalized.includes('coworker') || normalized.includes('colleague') || normalized.includes('boss') || normalized.includes('manager')) return 'coworker';
    if (normalized.includes('partner') || normalized.includes('project partner') || normalized.includes('teammate')) return 'project partner';
    if (normalized.includes('friend')) return 'friend';
    return 'relationship';
  }

  if (category === 'project' || category === 'projects') return 'project';
  return 'other';
}

async function upsertNameIndex(userId, memoryId, memoryText, category) {
  if (!userId || !memoryId || !memoryText) return null;

  const names = extractPersonNames(memoryText);
  if (!names.length) return null;

  const promises = names.map(async (name) => {
    const normalized = normalizeName(name);
    if (!normalized) return null;
    return MemoryNameIndex.findOneAndUpdate(
      { userId, memoryId, personNameLower: normalized },
      {
        userId,
        memoryId,
        personName: name,
        personNameLower: normalized,
        relationshipType: deriveRelationshipType(category, memoryText),
        category,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
  });

  const entries = await Promise.all(promises);
  return entries.filter(Boolean);
}

async function searchByName(userId, personName) {
  if (!userId || !personName) return [];
  const normalized = normalizeName(personName);
  return MemoryNameIndex.find({ userId, personNameLower: normalized }).lean().catch(() => []);
}

async function removeIndicesByMemoryId(memoryId) {
  if (!memoryId) return null;
  return MemoryNameIndex.deleteMany({ memoryId }).exec();
}

module.exports = { upsertNameIndex, searchByName, removeIndicesByMemoryId };
