const PersonProfile = require('../../models/PersonProfile');
const SacredMemory = require('../../models/SacredMemory');
const cacheConsistencyService = require('./cacheConsistencyService');
const { ensureUserId } = require('../../utils/ensureUserId');

async function buildRelationshipGraph(userId) {
  ensureUserId(userId);

  const profiles = await PersonProfile.find({ userId }).lean();
  const nodes = {};
  const edges = [];

  // Create user node
  nodes.user = {
    id: 'user',
    label: 'You',
    type: 'self',
  };

  // Create person nodes
  for (const profile of profiles) {
    nodes[profile.nameLower] = {
      id: profile.nameLower,
      label: profile.name,
      relationship: profile.relationship,
      importanceScore: profile.importanceScore,
      mentionCount: profile.mentionCount,
      lastMentioned: profile.lastMentioned,
    };

    // Add edges from user to person
    edges.push({
      from: 'user',
      to: profile.nameLower,
      relationship: profile.relationship,
      importance: profile.importanceScore,
      mentionCount: profile.mentionCount,
    });
  }

  // Add cross-person relationships
  for (const profile of profiles) {
    if (profile.relatedPeople && Array.isArray(profile.relatedPeople)) {
      for (const relatedName of profile.relatedPeople) {
        const related = profiles.find((p) => p.nameLower === relatedName.toLowerCase());
        if (related) {
          edges.push({
            from: profile.nameLower,
            to: related.nameLower,
            relationship: 'related',
          });
        }
      }
    }
  }

  return {
    userId,
    nodes: Object.values(nodes),
    edges,
    totalPeople: Object.keys(nodes).length - 1,
    totalRelationships: edges.length,
    generatedAt: new Date().toISOString(),
  };
}

async function getRelationshipSummary(userId) {
  ensureUserId(userId);

  const profiles = await PersonProfile.find({ userId }).sort({ mentionCount: -1 }).limit(20).lean();

  const summary = {
    family: profiles.filter((p) => p.relationship === 'family').map((p) => p.name),
    friends: profiles.filter((p) => p.relationship === 'friend').map((p) => p.name),
    mentors: profiles.filter((p) => p.relationship === 'mentor').map((p) => p.name),
    team: profiles.filter((p) => p.relationship === 'team').map((p) => p.name),
    partners: profiles.filter((p) => p.relationship === 'partner').map((p) => p.name),
    colleagues: profiles.filter((p) => p.relationship === 'colleague').map((p) => p.name),
    totalPeople: profiles.length,
    mostMentioned: profiles[0]?.name || null,
  };

  return summary;
}

async function findRelationshipMemories(userId, personName) {
  ensureUserId(userId);
  if (!personName || typeof personName !== 'string') {
    return [];
  }

  const profile = await PersonProfile.findOne({ userId, nameLower: personName.toLowerCase() }).lean();
  if (!profile) return [];

  const memories = await SacredMemory.find({
    userId,
    category: 'relationship',
    'metadata.personName': profile.name,
  }).lean();

  return memories.map((m) => ({
    _id: m._id,
    content: m.content,
    relationship: profile.relationship,
    lastMentioned: profile.lastMentioned,
    importance: profile.importanceScore,
  }));
}

async function addRelationshipConnection(userId, personName1, personName2) {
  ensureUserId(userId);

  const profile1 = await PersonProfile.findOne({ userId, nameLower: personName1.toLowerCase() }).lean();
  const profile2 = await PersonProfile.findOne({ userId, nameLower: personName2.toLowerCase() }).lean();

  if (profile1 && profile2) {
    await PersonProfile.updateOne(
      { _id: profile1._id },
      { $addToSet: { relatedPeople: profile2.name } }
    );
    await PersonProfile.updateOne(
      { _id: profile2._id },
      { $addToSet: { relatedPeople: profile1.name } }
    );
    try {
      await cacheConsistencyService.invalidateUserCaches(userId);
      await cacheConsistencyService.rebuildUserCaches(userId);
    } catch (e) {
      console.error('[RELATIONSHIP_CACHE_REBUILD_ERROR]', e);
      throw e;
    }
    console.log('[RELATIONSHIP_SAVE_SUCCESS]', { userId, pair: [personName1, personName2] });
  }

  return { success: Boolean(profile1 && profile2) };
}

module.exports = {
  buildRelationshipGraph,
  getRelationshipSummary,
  findRelationshipMemories,
  addRelationshipConnection,
};
