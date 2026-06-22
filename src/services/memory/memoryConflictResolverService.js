const LongTermMemory = require('../../models/LongTermMemory');
const { ensureUserId } = require('../../utils/ensureUserId');

async function markObsoleteMemories(obsoleteDocs, supersededById) {
  if (!Array.isArray(obsoleteDocs) || obsoleteDocs.length === 0) {
    return [];
  }

  const obsoleteIds = obsoleteDocs.map((doc) => doc._id || doc.id).filter(Boolean);
  if (!obsoleteIds.length) {
    return [];
  }

  await LongTermMemory.updateMany(
    { _id: { $in: obsoleteIds } },
    {
      $set: {
        active: false,
        obsolete: true,
        supersededBy: supersededById,
        updatedAt: new Date(),
      },
    }
  );

  return obsoleteIds;
}

async function resolveConflictOnSave(userId, fingerprint) {
  ensureUserId(userId);
  if (!fingerprint) {
    throw new Error('fingerprint is required');
  }

  const docs = await LongTermMemory.find({ userId, fingerprint, active: true }).sort({ updatedAt: -1 }).lean();
  if (docs.length <= 1) {
    return null;
  }

  const newest = docs[0];
  const obsolete = docs.slice(1);
  const obsoleteIds = await markObsoleteMemories(obsolete, newest._id);
  return {
    preservedId: newest._id,
    obsoleteIds,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = {
  markObsoleteMemories,
  resolveConflictOnSave,
};