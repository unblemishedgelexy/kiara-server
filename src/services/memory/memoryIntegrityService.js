const crypto = require('crypto');
const IdentityMemory = require('../../models/IdentityMemory');
const PreferenceMemory = require('../../models/PreferenceMemory');
const RelationshipMemory = require('../../models/RelationshipMemory');
const ProjectMemory = require('../../models/ProjectMemory');
const GoalMemory = require('../../models/GoalMemory');
const EpisodicMemory = require('../../models/EpisodicMemory');
const SacredMemory = require('../../models/SacredMemory');
const LongTermMemory = require('../../models/LongTermMemory');
const PersonProfile = require('../../models/PersonProfile');
const relationshipReferenceValidator = require('./relationshipReferenceValidator');
const memoryConflictResolverService = require('./memoryConflictResolverService');

const ALLOWED_CATEGORIES = [
  'identity',
  'preference',
  'relationship',
  'project',
  'goal',
  'life_fact',
  'fact',
  'event',
  'episodic',
  'other',
];

function normalizeText(text) {
  return String(text || '').trim();
}

function createFingerprint(text) {
  return crypto.createHash('sha256').update(normalizeText(text).toLowerCase()).digest('hex');
}

async function scanDuplicates(userId) {
  const duplicateIssues = [];

  const collections = [
    { name: 'LongTermMemory', model: LongTermMemory, field: 'fingerprint' },
  ];

  for (const coll of collections) {
    const groups = await coll.model
      .aggregate([
        { $match: { userId, [coll.field]: { $exists: true, $ne: null } } },
        { $group: { _id: `$${coll.field}`, count: { $sum: 1 }, ids: { $push: '$_id' } } },
        { $match: { count: { $gt: 1 } } },
      ])
      .allowDiskUse(false)
      .exec();

    for (const group of groups) {
      duplicateIssues.push({
        type: 'duplicate_fingerprint',
        collection: coll.name,
        fingerprint: group._id,
        count: group.count,
        ids: group.ids,
      });
    }
  }

  // Sacred memory duplicate detection by content fingerprint
  const sacredMemories = await SacredMemory.find({ userId }).lean();
  const sacredByFingerprint = new Map();
  for (const memory of sacredMemories) {
    const fingerprint = createFingerprint(memory.content || memory.encryptedContent || '');
    const record = sacredByFingerprint.get(fingerprint) || [];
    record.push(memory._id);
    sacredByFingerprint.set(fingerprint, record);
  }
  for (const [fingerprint, ids] of sacredByFingerprint.entries()) {
    if (ids.length > 1) {
      duplicateIssues.push({
        type: 'duplicate_fingerprint',
        collection: 'SacredMemory',
        fingerprint,
        count: ids.length,
        ids,
      });
    }
  }

  return duplicateIssues;
}

async function scanOrphans(userId) {
  const issues = [];

  const profiles = await PersonProfile.find({ userId }).lean();
  const profileMap = new Map(profiles.map((p) => [p._id.toString(), p]));
  const profileNames = new Map(profiles.map((p) => [p.name.toLowerCase(), p]));

  const relationships = await RelationshipMemory.find({ userId }).lean();
  for (const memory of relationships) {
    const personProfileId = memory.personProfileId ? String(memory.personProfileId) : null;
    const personName = memory.personProfileName || memory.metadata?.personName;

    if (!personProfileId && !personName) {
      issues.push({
        type: 'orphan_relationship',
        memoryId: memory._id,
        message: 'Relationship memory lacks profile reference and person name',
      });
      continue;
    }

    if (personProfileId && !profileMap.has(personProfileId)) {
      issues.push({
        type: 'invalid_reference',
        memoryId: memory._id,
        message: 'Relationship memory references missing personProfileId',
        personProfileId,
      });
    }

    if (!personProfileId && personName) {
      const profile = profileNames.get(personName.toLowerCase());
      if (!profile) {
        issues.push({
          type: 'invalid_reference',
          memoryId: memory._id,
          message: `Relationship memory personName does not match any profile: ${personName}`,
          personName,
        });
      }
    }
  }

  const sacred = await SacredMemory.find({ userId }).lean();
  const profileUsage = new Set();
  for (const memory of sacred) {
    const personName = memory.metadata?.personName;
    if (personName && profileNames.has(personName.toLowerCase())) {
      profileUsage.add(profileNames.get(personName.toLowerCase())._id.toString());
    }
  }
  for (const memory of relationships) {
    if (memory.personProfileId) {
      profileUsage.add(String(memory.personProfileId));
    }
  }

  for (const profile of profiles) {
    if (!profileUsage.has(profile._id.toString())) {
      issues.push({
        type: 'orphan_profile',
        profileId: profile._id,
        name: profile.name,
        message: 'Person profile is not referenced by any relationship or sacred memory',
      });
    }
  }

  return issues;
}

async function validateUserMemories(userId) {
  const start = process.hrtime();
  const issues = [];

  if (!userId) {
    throw new Error('userId is required');
  }

  const modelsToCheck = [IdentityMemory, PreferenceMemory, RelationshipMemory, ProjectMemory, GoalMemory, EpisodicMemory, LongTermMemory, SacredMemory];

  for (const model of modelsToCheck) {
    const docs = await model.find({ userId }).lean();
    for (const doc of docs) {
      if (!doc.userId) {
        issues.push({ type: 'missing_userId', collection: model.modelName, id: doc._id });
      }
      if (doc.category && !ALLOWED_CATEGORIES.includes(doc.category)) {
        issues.push({ type: 'invalid_category', collection: model.modelName, id: doc._id, category: doc.category });
      }
    }
  }

  const duplicates = await scanDuplicates(userId);
  const orphans = await scanOrphans(userId);
  const relationshipRefIssues = await relationshipReferenceValidator.validateRelationshipReferences(userId);

  issues.push(...duplicates, ...orphans, ...relationshipRefIssues);

  const elapsed = process.hrtime(start);
  const durationMs = Math.round((elapsed[0] * 1e9 + elapsed[1]) / 1e6);

  return {
    userId,
    issueCount: issues.length,
    issues,
    durationMs,
  };
}

async function repairIntegrityIssues(userId) {
  if (!userId) {
    throw new Error('userId is required');
  }

  const repairs = [];

  const relationshipRepairs = await relationshipReferenceValidator.repairRelationshipReferences(userId);
  if (relationshipRepairs && relationshipRepairs.length) {
    repairs.push({ type: 'relationship_reference_repair', count: relationshipRepairs.length, details: relationshipRepairs });
  }

  const duplicates = await scanDuplicates(userId);
  for (const duplicate of duplicates) {
    if (duplicate.collection === 'LongTermMemory') {
      const docs = await LongTermMemory.find({ userId, fingerprint: duplicate.fingerprint, active: true }).sort({ updatedAt: -1 }).lean();
      if (docs.length > 1) {
        const newest = docs[0];
        const obsolete = docs.slice(1);
        await memoryConflictResolverService.markObsoleteMemories(obsolete, newest._id);
        repairs.push({
          type: 'duplicate_obsolete_mark',
          fingerprint: duplicate.fingerprint,
          preservedId: newest._id,
          obsoleteIds: obsolete.map((d) => d._id),
        });
      }
    }
  }

  return {
    userId,
    repairs,
    repairedAt: new Date().toISOString(),
  };
}

module.exports = {
  validateUserMemories,
  scanDuplicates,
  scanOrphans,
  repairIntegrityIssues,
};