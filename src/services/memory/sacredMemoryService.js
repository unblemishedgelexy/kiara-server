const SacredMemory = require('../../models/SacredMemory');
const { encrypt, decrypt } = require('../../utils/crypto');
const { ensureUserId } = require('../../utils/ensureUserId');
const cacheConsistencyService = require('./cacheConsistencyService');

const SACRED_CATEGORIES = ['identity', 'family', 'relationship', 'goal', 'project', 'life_fact'];
const MAX_SACRED_PER_USER = 200;
const EXPLICIT_SACRED_PHRASES = /\b(remember this|never forget|important|yaad rakhna)\b/i;

function isExplicitSacredPhrase(text) {
  return EXPLICIT_SACRED_PHRASES.test(String(text || ''));
}

async function archiveExcessSacredMemories(userId) {
  const total = await SacredMemory.countDocuments({ userId, active: true });
  const overflow = total - MAX_SACRED_PER_USER;
  if (overflow <= 0) return 0;

  const toArchive = await SacredMemory.find({ userId, active: true })
    .sort({ 'strength.accessCount': 1, lastAccessed: 1, updatedAt: 1 })
    .limit(overflow)
    .select('_id')
    .lean();

  if (!toArchive.length) return 0;

  await SacredMemory.updateMany(
    { _id: { $in: toArchive.map((m) => m._id) } },
    { $set: { active: false, archivedAt: new Date() } }
  );
  return toArchive.length;
}

async function saveSacredMemory({ userId, category, content, metadata = {}, tags = [] }) {
  ensureUserId(userId);
  if (!SACRED_CATEGORIES.includes(category)) {
    throw new Error(`Invalid category. Must be one of: ${SACRED_CATEGORIES.join(', ')}`);
  }
  if (!content || typeof content !== 'string') {
    throw new Error('Content is required');
  }

  const normalizedContent = String(content).trim();
  const importanceScore = metadata.importance || 1;
  if (importanceScore < 0.9 && !isExplicitSacredPhrase(normalizedContent)) {
    throw new Error('Sacred memory must be high importance or include explicit sacred phrasing');
  }

  const encryptedContent = encrypt(normalizedContent);
  const memory = await SacredMemory.create({
    active: true,
    userId,
    category,
    content: String(content).trim(),
    encryptedContent,
    metadata,
    tags,
    strength: {
      importanceScore: 1,
      confidenceScore: 0.95,
      memoryStrength: 1,
      accessCount: 0,
    },
  });

  const archived = await archiveExcessSacredMemories(userId).catch(() => 0);
  try {
    const cacheConsistencyServiceLocal = require('./cacheConsistencyService');
    await cacheConsistencyServiceLocal.invalidateUserCaches(userId);
    await cacheConsistencyServiceLocal.rebuildUserCaches(userId);
  } catch (e) {
    console.error('[SACRED_CACHE_REBUILD_ERROR]', e);
  }

  return {
    archivedCount: archived,
    _id: memory._id,
    category: memory.category,
    content: memory.content,
    metadata: memory.metadata,
  };
}

async function getSacredMemoriesByCategory(userId, category) {
  ensureUserId(userId);
  if (!SACRED_CATEGORIES.includes(category)) {
    throw new Error(`Invalid category. Must be one of: ${SACRED_CATEGORIES.join(', ')}`);
  }

  const memories = await SacredMemory.find({ userId, category, active: true }).lean();
  return memories.map((m) => ({
    _id: m._id,
    category: m.category,
    content: m.content,
    metadata: m.metadata,
    strength: m.strength,
    tags: m.tags,
  }));
}

async function getSacredMemoriesByPerson(userId, personName) {
  ensureUserId(userId);
  if (!personName || typeof personName !== 'string') {
    throw new Error('Person name is required');
  }

  const memories = await SacredMemory.find({
    userId,
    active: true,
    $or: [
      { 'metadata.personName': new RegExp(personName, 'i') },
      { content: new RegExp(personName, 'i') },
    ],
  }).lean();

  return memories.map((m) => ({
    _id: m._id,
    category: m.category,
    content: m.content,
    personName: m.metadata.personName,
    strength: m.strength,
  }));
}

async function getAllSacredMemories(userId) {
  ensureUserId(userId);
  const memories = await SacredMemory.find({ userId, active: true }).lean();
  return memories.map((m) => ({
    _id: m._id,
    category: m.category,
    content: m.content,
    metadata: m.metadata,
    strength: m.strength,
  }));
}

async function incrementAccessCount(userId, memoryId) {
  ensureUserId(userId);
  await SacredMemory.findByIdAndUpdate(memoryId, {
    $inc: { 'strength.accessCount': 1 },
    $set: { lastAccessed: new Date() },
  });
}

async function updateMemoryStrength(userId, memoryId, scoreUpdates = {}) {
  ensureUserId(userId);
  const updates = {
    $set: { updatedAt: new Date() },
  };

  if (scoreUpdates.importanceScore !== undefined) {
    updates.$set['strength.importanceScore'] = Math.min(1, Math.max(0, scoreUpdates.importanceScore));
  }
  if (scoreUpdates.memoryStrength !== undefined) {
    updates.$set['strength.memoryStrength'] = Math.min(1, Math.max(0, scoreUpdates.memoryStrength));
  }

  await SacredMemory.findByIdAndUpdate(memoryId, updates);
}

module.exports = {
  saveSacredMemory,
  getSacredMemoriesByCategory,
  getSacredMemoriesByPerson,
  getAllSacredMemories,
  incrementAccessCount,
  updateMemoryStrength,
  SACRED_CATEGORIES,
};
