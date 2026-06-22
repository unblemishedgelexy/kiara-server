const { decrypt } = require('../../utils/crypto');
const { ensureUserId } = require('../../utils/ensureUserId');
const SacredMemory = require('../../models/SacredMemory');
const IdentityMemory = require('../../models/IdentityMemory');
const RelationshipMemory = require('../../models/RelationshipMemory');
const GoalMemory = require('../../models/GoalMemory');
const ProjectMemory = require('../../models/ProjectMemory');
const LongTermMemory = require('../../models/LongTermMemory');

async function hasActiveDocuments(model, query = {}) {
  return Boolean(await model.exists({ ...query, active: true }).catch(() => false));
}

async function repairModelFromLtm(userId, category, Model, limit = 2) {
  const docs = await LongTermMemory.find({ userId, category, active: true }).limit(limit).lean();
  if (!docs.length) return [];

  const repaired = [];
  for (const ltm of docs) {
    const doc = await Model.findOneAndUpdate(
      { userId, fingerprint: ltm.fingerprint },
      {
        $setOnInsert: {
          userId,
          category: ltm.category,
          encryptedMemory: ltm.encryptedMemory,
          tags: ltm.tags || [],
          importanceScore: ltm.importanceScore || 0.5,
          accessCount: ltm.accessCount || 0,
          lastAccessed: ltm.lastAccessed || new Date(),
          source: ltm.source || 'recovery',
          confidence: ltm.confidence || 0.5,
        },
      },
      { upsert: true, new: true }
    );
    if (doc) repaired.push(doc);
  }
  return repaired;
}

async function recoverIdentitySacredMemory(userId) {
  const existing = await SacredMemory.findOne({ userId, category: 'identity', active: true }).lean();
  if (existing) return null;

  const identityLtm = await LongTermMemory.findOne({ userId, category: 'identity', active: true }).lean();
  if (!identityLtm) return null;

  let content = '';
  try {
    content = decrypt(identityLtm.encryptedMemory);
  } catch (err) {
    content = `Recovered identity memory from fallback data`;
  }

  const memory = await SacredMemory.create({
    userId,
    category: 'identity',
    content,
    encryptedContent: identityLtm.encryptedMemory,
    metadata: {},
    strength: {
      importanceScore: identityLtm.importanceScore || 1,
      confidenceScore: identityLtm.confidence || 0.9,
      memoryStrength: 1,
      accessCount: identityLtm.accessCount || 0,
    },
    tags: identityLtm.tags || [],
    active: true,
    lastAccessed: identityLtm.lastAccessed || new Date(),
  });

  return memory;
}

async function ensureMemoryGuarantee(userId) {
  ensureUserId(userId);

  const repairs = [];

  if (!await hasActiveDocuments(IdentityMemory)) {
    repairs.push(...await repairModelFromLtm(userId, 'identity', IdentityMemory, 1));
  }

  if (!await hasActiveDocuments(RelationshipMemory)) {
    repairs.push(...await repairModelFromLtm(userId, 'relationship', RelationshipMemory, 3));
  }

  if (!await hasActiveDocuments(GoalMemory)) {
    repairs.push(...await repairModelFromLtm(userId, 'goal', GoalMemory, 2));
  }

  if (!await hasActiveDocuments(ProjectMemory)) {
    repairs.push(...await repairModelFromLtm(userId, 'project', ProjectMemory, 2));
  }

  await recoverIdentitySacredMemory(userId).catch(() => null);

  return {
    userId,
    repairedCount: repairs.length,
    recoveredIdentity: Boolean(await SacredMemory.exists({ userId, category: 'identity', active: true })),
  };
}

module.exports = {
  ensureMemoryGuarantee,
};
