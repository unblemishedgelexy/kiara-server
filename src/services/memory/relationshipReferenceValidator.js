const RelationshipMemory = require('../../models/RelationshipMemory');
const PersonProfile = require('../../models/PersonProfile');
const { ensureUserId } = require('../../utils/ensureUserId');

async function validateRelationshipReferences(userId) {
  ensureUserId(userId);

  const issues = [];
  const profiles = await PersonProfile.find({ userId }).lean();
  const profileById = new Map(profiles.map((p) => [String(p._id), p]));
  const profileByName = new Map(profiles.map((p) => [p.name.toLowerCase(), p]));

  const relationships = await RelationshipMemory.find({ userId }).lean();
  for (const rel of relationships) {
    const profileId = rel.personProfileId ? String(rel.personProfileId) : null;
    const profileName = rel.personProfileName || rel.metadata?.personName;

    if (profileId && !profileById.has(profileId)) {
      issues.push({
        type: 'missing_profile_reference',
        relationshipId: rel._id,
        personProfileId: profileId,
        message: 'Relationship references a missing person profile',
      });
      continue;
    }

    if (!profileId && profileName) {
      const matched = profileByName.get(profileName.toLowerCase());
      if (!matched) {
        issues.push({
          type: 'invalid_profile_reference',
          relationshipId: rel._id,
          personName: profileName,
          message: 'Relationship name does not match any PersonProfile',
        });
      }
    }
  }

  return issues;
}

async function repairRelationshipReferences(userId) {
  ensureUserId(userId);

  const repairs = [];
  const profiles = await PersonProfile.find({ userId }).lean();
  const profileByName = new Map(profiles.map((p) => [p.name.toLowerCase(), p]));

  const relationships = await RelationshipMemory.find({ userId }).lean();
  for (const rel of relationships) {
    const relPersonName = rel.personProfileName || rel.metadata?.personName;
    if (!rel.personProfileId && relPersonName) {
      const matchedProfile = profileByName.get(relPersonName.toLowerCase());
      if (matchedProfile) {
        await RelationshipMemory.updateOne(
          { _id: rel._id },
          {
            $set: {
              personProfileId: matchedProfile._id,
              personProfileName: matchedProfile.name,
              'metadata.personName': matchedProfile.name,
            },
          }
        );
        repairs.push({
          relationshipId: rel._id,
          personProfileId: matchedProfile._id,
          personName: matchedProfile.name,
          message: 'Linked relationship memory to PersonProfile',
        });
      }
    }
  }

  return repairs;
}

module.exports = {
  validateRelationshipReferences,
  repairRelationshipReferences,
};