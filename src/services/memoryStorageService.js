const crypto = require('crypto');
const { encrypt } = require('../utils/crypto');
const IdentityMemory = require('../models/IdentityMemory');
const PreferenceMemory = require('../models/PreferenceMemory');
const RelationshipMemory = require('../models/RelationshipMemory');
const ProjectMemory = require('../models/ProjectMemory');
const GoalMemory = require('../models/GoalMemory');
const EpisodicMemory = require('../models/EpisodicMemory');
const memoryConfidenceService = require('./memoryConfidenceService');

const CATEGORY_MODEL_MAP = {
  identity: IdentityMemory,
  preference: PreferenceMemory,
  relationship: RelationshipMemory,
  project: ProjectMemory,
  goal: GoalMemory,
  fact: EpisodicMemory,
  event: EpisodicMemory,
  episodic: EpisodicMemory,
};

function createFingerprint(text) {
  return crypto.createHash('sha256').update(String(text || '').trim().toLowerCase()).digest('hex');
}

function getModelForCategory(category) {
  return CATEGORY_MODEL_MAP[category] || EpisodicMemory;
}

async function saveMemory({ userId, category, memory, tags = [], importanceScore = 0.5, source = 'pipeline' }) {
  const normalizedMemory = String(memory || '').trim();
  if (!normalizedMemory) {
    throw new Error('Memory text is required');
  }

  const fingerprint = createFingerprint(normalizedMemory);
  const encryptedMemory = encrypt(normalizedMemory);
  const Model = getModelForCategory(category);

  const existing = await Model.findOne({ userId, fingerprint }).lean();
  if (existing) {
    const updated = await Model.findOneAndUpdate(
      { _id: existing._id },
      {
        $set: {
          encryptedMemory,
          importanceScore: Math.max(existing.importanceScore || 0, importanceScore),
          source,
          updatedAt: new Date(),
        },
        $inc: { accessCount: 1 },
        $setOnInsert: { category, tags, fingerprint },
      },
      { new: true }
    ).lean();
    try { await Model.updateOne({ _id: updated._id }, { $set: { confidence: memoryConfidenceService.computeConfidenceForDoc(updated) } }).exec(); } catch (e) {}
    return updated;
  }

  const doc = await Model.create({
    userId,
    category,
    encryptedMemory,
    fingerprint,
    tags,
    importanceScore,
    source,
    accessCount: 1,
    lastAccessed: new Date(),
    confidence: memoryConfidenceService.computeConfidenceForDoc({ importanceScore, accessCount: 1, memoryStrength: 1 }),
  });
  return doc.toObject ? doc.toObject() : doc;
}

module.exports = { saveMemory, getModelForCategory };