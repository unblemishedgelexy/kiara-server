const LongTermMemory = require('../../models/LongTermMemory');
const memoryNameIndexService = require('./memoryNameIndexService');
const { decrypt } = require('../../utils/crypto');
const { ensureUserId } = require('../../utils/ensureUserId');

function normalizeText(text) {
  return String(text || '').trim();
}

async function upsertMemoryNameIndices(userId, memoryId, memoryText, category, canonicalMemoryId = null) {
  ensureUserId(userId);
  if (!memoryId || !memoryText) return null;
  return memoryNameIndexService.upsertNameIndex(userId, memoryId, normalizeText(memoryText), category, canonicalMemoryId);
}

async function recallByName(userId, personName) {
  ensureUserId(userId);
  if (!personName || typeof personName !== 'string') return [];

  const indices = await memoryNameIndexService.searchByName(userId, personName);
  if (!indices.length) return [];

  const memoryIds = Array.from(new Set(indices.map((entry) => entry.canonicalMemoryId || entry.memoryId).filter(Boolean)));
  if (!memoryIds.length) {
    return indices.map((entry) => ({ personName: entry.personName, relationshipType: entry.relationshipType, memoryPreview: entry.memoryPreview || '' }));
  }

  const memories = await LongTermMemory.find({ userId, _id: { $in: memoryIds } }).lean();
  return memories.map((doc) => ({
    id: String(doc._id),
    category: doc.category,
    memory: decrypt(doc.encryptedMemory),
    tags: doc.tags,
    importanceScore: doc.importanceScore,
    preview: decrypt(doc.encryptedMemory).slice(0, 256),
    relationships: indices
      .filter((entry) => String(entry.canonicalMemoryId || entry.memoryId) === String(doc._id))
      .map((entry) => ({ personName: entry.personName, relationshipType: entry.relationshipType })),
  }));
}

async function listKnownNames(userId) {
  ensureUserId(userId);
  const names = await memoryNameIndexService.getDistinctNames(userId);
  return names.map((name) => ({ name, normalized: String(name || '').trim().toLowerCase() }));
}

module.exports = {
  upsertMemoryNameIndices,
  recallByName,
  listKnownNames,
};
