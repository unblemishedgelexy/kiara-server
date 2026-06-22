const SacredMemory = require('../../models/SacredMemory');
const LongTermMemory = require('../../models/LongTermMemory');
const { ensureUserId } = require('../../utils/ensureUserId');

function calculateMemoryStrength(accessCount, mentionCount, recency, importance) {
  // Recency bonus (recent access strengthens memory)
  const now = Date.now();
  const age = Math.max(0, (now - recency.getTime()) / (1000 * 60 * 60 * 24)); // days
  const recencyBonus = Math.max(0, 1 - age / 365); // decay over a year

  // Access frequency
  const accessScore = Math.min(1, accessCount / 10);

  // Mention frequency
  const mentionScore = Math.min(1, mentionCount / 10);

  // Combined strength
  const strength = (accessScore * 0.4 + mentionScore * 0.3 + recencyBonus * 0.2 + importance * 0.1);

  return Math.min(1, Math.max(0, strength));
}

async function recordMemoryAccess(userId, memoryId, source = 'sacred') {
  ensureUserId(userId);

  const Model = source === 'sacred' ? SacredMemory : LongTermMemory;
  const memory = await Model.findById(memoryId);

  if (!memory) return null;

  const newAccessCount = (memory.strength?.accessCount || 0) + 1;
  const newStrength = calculateMemoryStrength(
    newAccessCount,
    memory.strength?.mentionCount || 0,
    memory.lastAccessed || memory.createdAt,
    memory.strength?.importanceScore || 0.5
  );

  const updates = {
    $set: {
      lastAccessed: new Date(),
      'strength.accessCount': newAccessCount,
      'strength.memoryStrength': newStrength,
    },
  };

  return Model.findByIdAndUpdate(memoryId, updates, { new: true });
}

async function recordMemoryMention(userId, memoryId, source = 'sacred') {
  ensureUserId(userId);

  const Model = source === 'sacred' ? SacredMemory : LongTermMemory;
  const memory = await Model.findById(memoryId);

  if (!memory) return null;

  const newMentionCount = (memory.strength?.mentionCount || 0) + 1;
  const newStrength = calculateMemoryStrength(
    memory.strength?.accessCount || 0,
    newMentionCount,
    new Date(),
    memory.strength?.importanceScore || 0.5
  );

  const updates = {
    $set: {
      'strength.mentionCount': newMentionCount,
      'strength.memoryStrength': newStrength,
    },
  };

  return Model.findByIdAndUpdate(memoryId, updates, { new: true });
}

async function updateMemoryImportance(userId, memoryId, importanceScore, source = 'sacred') {
  ensureUserId(userId);
  if (typeof importanceScore !== 'number' || importanceScore < 0 || importanceScore > 1) {
    throw new Error('Importance score must be between 0 and 1');
  }

  const Model = source === 'sacred' ? SacredMemory : LongTermMemory;
  const memory = await Model.findById(memoryId);

  if (!memory) return null;

  const newStrength = calculateMemoryStrength(
    memory.strength?.accessCount || 0,
    memory.strength?.mentionCount || 0,
    memory.lastAccessed || memory.createdAt,
    importanceScore
  );

  const updates = {
    $set: {
      'strength.importanceScore': importanceScore,
      'strength.memoryStrength': newStrength,
    },
  };

  return Model.findByIdAndUpdate(memoryId, updates, { new: true });
}

async function getHighStrengthMemories(userId, threshold = 0.7) {
  ensureUserId(userId);

  const memories = await SacredMemory.find({
    userId,
    'strength.memoryStrength': { $gte: threshold },
  })
    .sort({ 'strength.memoryStrength': -1 })
    .lean();

  return memories;
}

async function getWeakMemories(userId, threshold = 0.3) {
  ensureUserId(userId);

  const memories = await LongTermMemory.find({
    userId,
    'strength.memoryStrength': { $lte: threshold },
  })
    .sort({ 'strength.memoryStrength': 1 })
    .lean();

  return memories;
}

module.exports = {
  calculateMemoryStrength,
  recordMemoryAccess,
  recordMemoryMention,
  updateMemoryImportance,
  getHighStrengthMemories,
  getWeakMemories,
};
