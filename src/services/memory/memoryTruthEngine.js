const { ensureUserId } = require('../../utils/ensureUserId');
const LongTermMemory = require('../../models/LongTermMemory');
const IdentityMemory = require('../../models/IdentityMemory');
const RelationshipMemory = require('../../models/RelationshipMemory');
const SacredMemory = require('../../models/SacredMemory');
const sessionMemoryService = require('./sessionMemoryService');

/**
 * Memory Truth Engine (V7)
 * Enforces single source of truth across memory types.
 * Priority: SacredMemory > RelationshipMemory > LongTermMemory > SessionMemory
 * Contradictory memories are automatically superseded.
 */

// Priority order (descending)
const MEMORY_TYPE_PRIORITY = {
  'SacredMemory': 4,
  'IdentityMemory': 3.5,
  'RelationshipMemory': 3,
  'GoalMemory': 2.5,
  'ProjectMemory': 2,
  'EpisodicMemory': 1.5,
  'LongTermMemory': 1,
  'SessionMemory': 0,
};

async function resolveTruth(userId, topic, content) {
  ensureUserId(userId);

  if (!topic || !content) {
    throw new Error('topic and content are required');
  }

  const fingerprint = createFingerprint(topic, content);
  const results = [];

  // Search all memory types for this topic
  const sacred = await SacredMemory.findOne({ userId, metadata: { $elemMatch: { personName: topic } } }).lean();
  const relationships = await RelationshipMemory.find({ userId, 'metadata.personName': topic }).lean();
  const ltm = await LongTermMemory.findOne({ userId, fingerprint, active: true }).lean();
  // Session memory is stored via sessionMemoryService (in-memory/redis); fetch active session
  const session = await sessionMemoryService.getActiveSessionMemory(userId).catch(() => null);
  const identity = await IdentityMemory.findOne({ userId, metadata: { $elemMatch: { personName: topic } } }).lean();

  if (sacred && sacred.active) results.push({ type: 'SacredMemory', doc: sacred, priority: MEMORY_TYPE_PRIORITY.SacredMemory });
  if (identity && identity.active) results.push({ type: 'IdentityMemory', doc: identity, priority: MEMORY_TYPE_PRIORITY.IdentityMemory });
  if (relationships.length) {
    for (const rel of relationships) {
      if (rel.active) results.push({ type: 'RelationshipMemory', doc: rel, priority: MEMORY_TYPE_PRIORITY.RelationshipMemory });
    }
  }
  if (ltm && ltm.active) results.push({ type: 'LongTermMemory', doc: ltm, priority: MEMORY_TYPE_PRIORITY.LongTermMemory });
  if (session && session.active) results.push({ type: 'SessionMemory', doc: session, priority: MEMORY_TYPE_PRIORITY.SessionMemory });

  // Sort by priority (descending) and return highest priority
  results.sort((a, b) => b.priority - a.priority);
  
  if (results.length === 0) {
    return { truthSource: null, conflicts: [] };
  }

  const truth = results[0];
  const conflicts = results.slice(1);

  // Mark all conflicting lower-priority memories as obsolete
  if (conflicts.length > 0) {
    for (const conflict of conflicts) {
      await markAsObsolete(conflict.doc._id, conflict.type, truth.doc._id);
    }
  }

  return {
    truthSource: { type: truth.type, id: truth.doc._id, priority: truth.priority },
    content: truth.doc,
    conflictsResolved: conflicts.length,
    conflicts: conflicts.map((c) => ({ type: c.type, id: c.doc._id })),
  };
}

async function markAsObsolete(docId, docType, supersededById) {
  const models = {
    SacredMemory: require('../../models/SacredMemory'),
    IdentityMemory: require('../../models/IdentityMemory'),
    RelationshipMemory: require('../../models/RelationshipMemory'),
    LongTermMemory: require('../../models/LongTermMemory'),
    // SessionMemory model is not backed by Mongo; handled via sessionMemoryService
    ProjectMemory: require('../../models/ProjectMemory'),
    GoalMemory: require('../../models/GoalMemory'),
    EpisodicMemory: require('../../models/EpisodicMemory'),
  };

  const Model = models[docType];
  if (!Model) return;

  try {
    await Model.updateOne(
      { _id: docId },
      {
        $set: {
          active: false,
          obsolete: true,
          supersededBy: supersededById,
          obsoletedAt: new Date(),
        },
      }
    );
  } catch (err) {
    console.error(`Failed to mark ${docType} as obsolete:`, err);
  }
}

async function enforceTruthOnSave(userId, memoryType, content) {
  ensureUserId(userId);

  // Extract topic from content or metadata
  let topic = null;
  if (typeof content === 'string') {
    topic = content.split(' ')[0]; // Simple extraction
  } else if (content.metadata && content.metadata.personName) {
    topic = content.metadata.personName;
  }

  if (!topic) return { enforced: false };

  const resolution = await resolveTruth(userId, topic, JSON.stringify(content));
  
  return {
    enforced: resolution.conflictsResolved > 0,
    truthSource: resolution.truthSource,
    conflictsResolved: resolution.conflictsResolved,
  };
}

function createFingerprint(topic, content) {
  const crypto = require('crypto');
  const normalized = `${topic}:${JSON.stringify(content)}`.toLowerCase().trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

module.exports = {
  resolveTruth,
  markAsObsolete,
  enforceTruthOnSave,
  MEMORY_TYPE_PRIORITY,
};
