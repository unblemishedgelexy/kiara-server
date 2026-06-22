const { ensureUserId } = require('../../utils/ensureUserId');
const PersonProfile = require('../../models/PersonProfile');
const RelationshipMemory = require('../../models/RelationshipMemory');
const stringSimilarity = require('string-similarity');

/**
 * Person Identity Resolver (V7)
 * Merges similar person names into single PersonProfile.
 * Consolidates "Aman", "Aman Bhai", "Aman Patel" → single profile
 */

const SIMILARITY_THRESHOLD = 0.75; // 75% match = merge

async function resolveSimilarIdentities(userId) {
  ensureUserId(userId);

  const profiles = await PersonProfile.find({ userId }).lean();
  const merges = [];

  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      const similarity = stringSimilarity.compareTwoStrings(
        profiles[i].name.toLowerCase(),
        profiles[j].name.toLowerCase()
      );

      if (similarity >= SIMILARITY_THRESHOLD) {
        // Merge j into i (keep older one as primary)
        const older = profiles[i].createdAt <= profiles[j].createdAt ? profiles[i] : profiles[j];
        const newer = profiles[i].createdAt <= profiles[j].createdAt ? profiles[j] : profiles[i];

        const merge = await mergeIdentities(userId, older._id, newer._id, similarity);
        merges.push(merge);
      }
    }
  }

  return {
    userId,
    mergesApplied: merges.length,
    details: merges,
  };
}

async function mergeIdentities(userId, primaryId, secondaryId, similarity) {
  ensureUserId(userId);

  const primary = await PersonProfile.findById(primaryId);
  const secondary = await PersonProfile.findById(secondaryId);

  if (!primary || !secondary) {
    throw new Error('One or both profiles not found');
  }

  // Update relationship memories to point to primary
  await RelationshipMemory.updateMany(
    { userId, personProfileId: secondaryId },
    { $set: { personProfileId: primaryId, personProfileName: primary.name } }
  );

  // Merge important data from secondary into primary
  const mergedProfile = {
    name: primary.name, // Keep primary name
    nameLower: primary.name.toLowerCase(),
    relationship: primary.relationship || secondary.relationship,
    mentionCount: (primary.mentionCount || 0) + (secondary.mentionCount || 0),
    importanceScore: Math.max(primary.importanceScore || 0, secondary.importanceScore || 0),
    relatedPeople: [...new Set([...(primary.relatedPeople || []), ...(secondary.relatedPeople || [])])],
    accessCount: (primary.accessCount || 0) + (secondary.accessCount || 0),
    facts: [...new Set([...(primary.facts || []), ...(secondary.facts || [])])],
    lastMentioned: new Date(Math.max(
      primary.lastMentioned?.getTime() || 0,
      secondary.lastMentioned?.getTime() || 0
    )),
  };

  await PersonProfile.updateOne({ _id: primaryId }, { $set: mergedProfile });

  // Mark secondary as obsolete (soft delete via new field if schema allows)
  await PersonProfile.updateOne(
    { _id: secondaryId },
    { 
      $set: { 
        active: false, 
        obsolete: true,
        mergedInto: primaryId,
        mergedAt: new Date(),
      } 
    }
  );

  return {
    primaryId,
    secondaryId,
    primaryName: primary.name,
    secondaryName: secondary.name,
    similarity,
    relationshipsUpdated: await RelationshipMemory.countDocuments({ userId, personProfileId: primaryId }),
  };
}

async function consolidateNames(userId) {
  ensureUserId(userId);

  const profiles = await PersonProfile.find({ userId }).lean();
  const nameGroups = new Map();

  // Group by normalized name
  for (const profile of profiles) {
    const normalized = normalizeName(profile.name);
    if (!nameGroups.has(normalized)) {
      nameGroups.set(normalized, []);
    }
    nameGroups.get(normalized).push(profile);
  }

  // Consolidate each group
  const consolidations = [];
  for (const [normalized, group] of nameGroups.entries()) {
    if (group.length > 1) {
      // Keep oldest, merge rest
      const sorted = group.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const primary = sorted[0];

      for (let i = 1; i < sorted.length; i++) {
        const consolidation = await mergeIdentities(userId, primary._id, sorted[i]._id, 1.0);
        consolidations.push(consolidation);
      }
    }
  }

  return {
    userId,
    consolidationsApplied: consolidations.length,
    details: consolidations,
  };
}

function normalizeName(name) {
  // Remove common suffixes and normalize
  return name
    .toLowerCase()
    .trim()
    .split(/\s+/)[0] // Take first word
    .replace(/[^\w]/g, ''); // Remove special chars
}

async function getPersonIdentity(userId, personName) {
  ensureUserId(userId);

  if (!personName) return null;

  const normalized = normalizeName(personName);
  const profiles = await PersonProfile.find({ userId, active: { $ne: false } }).lean();

  // Find exact match first
  let match = profiles.find((p) => p.name.toLowerCase() === personName.toLowerCase());
  if (match) return match;

  // Find by name similarity
  const similarities = profiles.map((p) => ({
    profile: p,
    similarity: stringSimilarity.compareTwoStrings(
      normalizeName(p.name),
      normalized
    ),
  }));

  similarities.sort((a, b) => b.similarity - a.similarity);

  if (similarities[0]?.similarity >= SIMILARITY_THRESHOLD) {
    return similarities[0].profile;
  }

  return null;
}

module.exports = {
  resolveSimilarIdentities,
  mergeIdentities,
  consolidateNames,
  getPersonIdentity,
  SIMILARITY_THRESHOLD,
};
