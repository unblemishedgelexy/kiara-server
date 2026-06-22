const crypto = require('crypto');
const { encrypt } = require('../../utils/crypto');
const IdentityMemory = require('../../models/IdentityMemory');
const PreferenceMemory = require('../../models/PreferenceMemory');
const RelationshipMemory = require('../../models/RelationshipMemory');
const ProjectMemory = require('../../models/ProjectMemory');
const GoalMemory = require('../../models/GoalMemory');
const EpisodicMemory = require('../../models/EpisodicMemory');
const memoryConfidenceService = require('./memoryConfidenceService');
const memoryMetricsService = require('./memoryMetricsService');
const memoryConflictResolverService = require('./memoryConflictResolverService');
const cacheConsistencyService = require('./cacheConsistencyService');
const LongTermMemory = require('../../models/LongTermMemory');
const nameRecallService = require('./nameRecallService');
// V7 Services
const memoryQualityFilter = require('./memoryQualityFilter');
const memoryTruthEngine = require('./memoryTruthEngine');
const personProfileService = require('./personProfileService');
const memoryProfileService = require('./memoryProfileService');
const sessionBootstrapService = require('./sessionBootstrapService');
const relationshipMemoryEngine = require('./relationshipMemoryEngine');
const relationshipCacheService = require('../infrastructure/relationshipCacheService');
const { ensureUserId } = require('../../utils/ensureUserId');

const CATEGORY_MODEL_MAP = {
  identity: IdentityMemory,
  preference: PreferenceMemory,
  preferences: PreferenceMemory,
  relationship: RelationshipMemory,
  relationships: RelationshipMemory,
  project: ProjectMemory,
  projects: ProjectMemory,
  goal: GoalMemory,
  goals: GoalMemory,
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

async function updateRelationshipRecall(userId, normalizedMemory) {
  if (!normalizedMemory || typeof normalizedMemory !== 'string') return;

  const parsed = relationshipCacheService.parseRelationshipMemory(normalizedMemory);
  if (!parsed.personName) return;

  const relationshipType = String(parsed.relationshipType || 'other').toLowerCase();
  const canonicalRelationship = ['family', 'friend', 'mentor', 'team', 'partner', 'colleague'].includes(relationshipType)
    ? relationshipType
    : 'other';

  const profile = await personProfileService.upsertPersonProfile(userId, parsed.personName, {
    relationship: canonicalRelationship,
  });
  console.log('[PERSON_PROFILE_SUCCESS]', { userId, personName: parsed.personName, profileId: profile?._id, relationship: canonicalRelationship });

  const stopWords = new Set(['my', 'i', 'best', 'friend', 'relationship', 'is', 'named', 'called', 'who', "who's", 'was', 'a', 'an', 'the', 'and', 'or']);
  const discoveredNames = Array.from(
    new Set(
      (normalizedMemory.match(/\b([A-Z][a-z]+(?: [A-Z][a-z]+)*)\b/g) || [])
        .map((name) => String(name).trim())
        .filter((name) => name.length > 1 && !stopWords.has(name.toLowerCase()))
    )
  );

  if (parsed.personName && !discoveredNames.includes(parsed.personName)) {
    discoveredNames.unshift(parsed.personName);
  }

  if (discoveredNames.length > 1) {
    for (let i = 0; i < discoveredNames.length; i += 1) {
      for (let j = i + 1; j < discoveredNames.length; j += 1) {
        await relationshipMemoryEngine.addRelationshipConnection(userId, discoveredNames[i], discoveredNames[j]);
      }
    }
  }

  await relationshipCacheService.cacheRelationshipContext(userId);
}

async function saveMemory({ userId, category, memory, tags = [], importanceScore = 0.5, source = 'pipeline' }) {
  ensureUserId(userId);
  
  const normalizedMemory = String(memory || '').trim();
  if (!normalizedMemory) {
    throw new Error('Memory text is required');
  }

  // V7: Quality filtering - reject low-value memories
  const qualityCheck = memoryQualityFilter.evaluateMemoryQuality({ text: normalizedMemory });
  if (!qualityCheck.shouldSave) {
    return {
      success: false,
      reason: 'low_quality_content',
      quality: qualityCheck,
    };
  }

  const fingerprint = createFingerprint(normalizedMemory);
  const encryptedMemory = encrypt(normalizedMemory);
  const Model = getModelForCategory(category);

  // V7: Enforce truth - check for contradictory memories
  const truthResult = await memoryTruthEngine.enforceTruthOnSave(userId, category, normalizedMemory).catch(() => ({ enforced: false }));

  await memoryConflictResolverService.resolveConflictOnSave(userId, fingerprint).catch(() => null);

  console.log('[MEMORY_SAVE_START]', { userId, category, fingerprint, preview: normalizedMemory.slice(0, 120) });

  const existing = await Model.findOne({ userId, fingerprint }).lean();
  if (existing) {
    try {
      await memoryMetricsService.incrementDuplicateMemoryCount(userId);
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
        { returnDocument: 'after' }
      ).lean();

      try {
        await Model.updateOne({ _id: updated._id }, { $set: { confidence: memoryConfidenceService.computeConfidenceForDoc(updated) } }).exec();
      } catch (e) {
        console.error('[MEMORY_SAVE_ERROR] confidence update failed', e);
        throw e;
      }

      // Ensure canonical LTM is kept in sync (upsert by fingerprint)
      console.log('[LTM_UPSERT_START]', { userId, fingerprint, category: updated.category, source, branch: 'existing' });
      let ltmDoc;
      try {
        ltmDoc = await LongTermMemory.findOneAndUpdate(
          { userId, fingerprint },
          {
            $set: {
              category: updated.category,
              encryptedMemory: updated.encryptedMemory,
              importanceScore: Math.max(updated.importanceScore || 0, importanceScore),
              tags: updated.tags || [],
              source,
              updatedAt: new Date(),
              confidence: memoryConfidenceService.computeConfidenceForDoc(updated),
              active: true,
              obsolete: false,
              supersededBy: null,
            },
            $inc: { accessCount: 1 },
            $setOnInsert: { userId, fingerprint },
          },
          { upsert: true, returnDocument: 'after' }
        ).lean();
        console.log('[LTM_UPSERT_SUCCESS]', { userId, fingerprint, ltmId: ltmDoc?._id, branch: 'existing', action: ltmDoc ? 'updated_or_inserted' : 'inserted' });
      } catch (ltmError) {
        console.error('[LTM_UPSERT_FAILED]', { userId, fingerprint, error: ltmError.message, stack: ltmError.stack });
        throw ltmError;
      }

      await memoryConflictResolverService.resolveConflictOnSave(userId, fingerprint);
      await cacheConsistencyService.invalidateUserCaches(userId);
      await cacheConsistencyService.rebuildUserCaches(userId);

      const nameIndices = await nameRecallService.upsertMemoryNameIndices(userId, String(updated._id), normalizedMemory, updated.category);
      console.log('[NAME_INDEX_SUCCESS]', { userId, memoryId: String(updated._id), count: (nameIndices || []).length });

      let relationshipInfo = null;
      if (category === 'relationship') {
        relationshipInfo = await updateRelationshipRecall(userId, normalizedMemory);
        if (relationshipInfo) {
          console.log('[RELATIONSHIP_SAVE_SUCCESS]', { userId, ...relationshipInfo, memoryId: String(updated._id) });
        }
      }

      try {
        await memoryProfileService.rebuildMemoryProfile(userId);
        console.log('[PROFILE_REBUILD_SUCCESS]', { userId });
      } catch (profileError) {
        console.warn('[PROFILE_REBUILD_FAILED]', { userId, error: profileError && profileError.message ? profileError.message : profileError });
      }

      try {
        await sessionBootstrapService.buildSessionBootstrapContext(userId, true);
        console.log('[BOOTSTRAP_REBUILD_SUCCESS]', { userId });
      } catch (bootstrapError) {
        console.warn('[BOOTSTRAP_REBUILD_FAILED]', { userId, error: bootstrapError && bootstrapError.message ? bootstrapError.message : bootstrapError });
      }

      return updated;
    } catch (e) {
      console.error('[MEMORY_SAVE_ERROR] failed to update existing memory', e);
      throw e;
    }
  }

  try {
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

    // Also ensure canonical LongTermMemory entry exists (deduplicated by fingerprint)
    console.log('[LTM_UPSERT_START]', { userId, fingerprint, category, source, branch: 'create' });
    let ltmDoc;
    try {
      ltmDoc = await LongTermMemory.findOneAndUpdate(
        { userId, fingerprint },
        {
          $set: {
            category,
            encryptedMemory,
            tags,
            importanceScore,
            source,
            updatedAt: new Date(),
            confidence: memoryConfidenceService.computeConfidenceForDoc({ importanceScore, accessCount: 1, memoryStrength: 1 }),
            active: true,
            obsolete: false,
            supersededBy: null,
          },
          $setOnInsert: { userId, fingerprint, accessCount: 1 },
        },
        { upsert: true, returnDocument: 'after' }
      ).lean();
      console.log('[LTM_UPSERT_SUCCESS]', { userId, fingerprint, ltmId: ltmDoc?._id, branch: 'create', action: ltmDoc ? 'updated_or_inserted' : 'inserted' });
    } catch (ltmError) {
      console.error('[LTM_UPSERT_FAILED]', { userId, fingerprint, error: ltmError.message, stack: ltmError.stack });
      throw ltmError;
    }

    await memoryConflictResolverService.resolveConflictOnSave(userId, fingerprint);
    await cacheConsistencyService.invalidateUserCaches(userId);
    await cacheConsistencyService.rebuildUserCaches(userId);

    const nameIndices = await nameRecallService.upsertMemoryNameIndices(userId, String(doc._id), normalizedMemory, category);
    console.log('[NAME_INDEX_SUCCESS]', { userId, memoryId: String(doc._id), count: (nameIndices || []).length });

    let relationshipInfo = null;
    if (category === 'relationship') {
      relationshipInfo = await updateRelationshipRecall(userId, normalizedMemory);
      if (relationshipInfo) {
        console.log('[RELATIONSHIP_SAVE_SUCCESS]', { userId, ...relationshipInfo, memoryId: String(doc._id) });
      }
    }
    console.log('[MEMORY_SAVE_SUCCESS]', { userId, memoryId: String(doc._id) });

    // Rebuild profile and bootstrap synchronously for verification
    try {
      await memoryProfileService.rebuildMemoryProfile(userId);
      console.log('[PROFILE_REBUILD_SUCCESS]', { userId });
    } catch (profileError) {
      console.warn('[PROFILE_REBUILD_FAILED]', { userId, error: profileError && profileError.message ? profileError.message : profileError });
    }

    try {
      await sessionBootstrapService.buildSessionBootstrapContext(userId, true);
      console.log('[BOOTSTRAP_REBUILD_SUCCESS]', { userId });
    } catch (bootstrapError) {
      console.warn('[BOOTSTRAP_REBUILD_FAILED]', { userId, error: bootstrapError && bootstrapError.message ? bootstrapError.message : bootstrapError });
    }

    return doc.toObject ? doc.toObject() : doc;
  } catch (e) {
    console.error('[MEMORY_SAVE_ERROR] failed to create memory', e);
    throw e;
  }
}

module.exports = { saveMemory, getModelForCategory, updateRelationshipRecall };