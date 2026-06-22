const PersonProfile = require('../../models/PersonProfile');
const cacheConsistencyService = require('./cacheConsistencyService');
const { ensureUserId } = require('../../utils/ensureUserId');

const GENERIC_PERSON_NAMES = new Set([
  'my',
  'me',
  'friend',
  'buddy',
  'someone',
  'unknown',
  'dummy',
  'example',
  'test',
  'filler',
]);

const MIN_PROFILE_CONFIDENCE = 0.7;

function normalizePersonName(personName) {
  return String(personName || '').trim();
}

function isAllowedPersonName(personName) {
  if (!personName || typeof personName !== 'string') return false;
  const normalized = normalizePersonName(personName);
  if (!normalized) return false;
  if (GENERIC_PERSON_NAMES.has(normalized.toLowerCase())) return false;
  return normalized.split(' ').every((token) => token && !GENERIC_PERSON_NAMES.has(token.toLowerCase()));
}

async function upsertPersonProfile(userId, personName, updates = {}) {
  ensureUserId(userId);
  if (!personName || typeof personName !== 'string') {
    throw new Error('Person name is required');
  }

  if (!isAllowedPersonName(personName)) {
    console.warn('[PERSON_PROFILE_REJECTED] generic or invalid person name', { userId, personName });
    return null;
  }

  if (typeof updates.confidence === 'number' && updates.confidence < MIN_PROFILE_CONFIDENCE) {
    console.warn('[PERSON_PROFILE_REJECTED] confidence below threshold', { userId, personName, confidence: updates.confidence });
    return null;
  }

  const nameLower = personName.toLowerCase().trim();
  const profile = await PersonProfile.findOneAndUpdate(
    { userId, nameLower },
    {
      $set: {
        name: personName,
        relationship: updates.relationship || 'other',
        ...updates,
      },
      $inc: { mentionCount: 1 },
      $setOnInsert: { userId, nameLower, createdAt: new Date() },
    },
    { upsert: true, returnDocument: 'after' }
  );

  try {
    await cacheConsistencyService.invalidateUserCaches(userId);
    await cacheConsistencyService.rebuildUserCaches(userId);
  } catch (e) {
    console.error('[PERSON_PROFILE_CACHE_REBUILD_ERROR]', e);
    throw e;
  }

  console.log('[PERSON_PROFILE_SAVE_SUCCESS]', { userId, personName, confidence: updates.confidence, profileId: profile?._id });
  return profile;
}

async function getPersonProfile(userId, personName) {
  ensureUserId(userId);
  if (!personName || typeof personName !== 'string') {
    return null;
  }

  const profile = await PersonProfile.findOne({ userId, nameLower: personName.toLowerCase() }).lean();
  return profile;
}

async function updatePersonRelationship(userId, personName, relationshipType) {
  ensureUserId(userId);
  if (!['friend', 'family', 'mentor', 'team', 'partner', 'colleague', 'other'].includes(relationshipType)) {
    throw new Error('Invalid relationship type');
  }

  const profile = await PersonProfile.findOneAndUpdate({ userId, nameLower: personName.toLowerCase() }, { relationship: relationshipType }, { returnDocument: 'after' });
  if (profile) {
    cacheConsistencyService.invalidateUserCaches(userId).catch(() => null);
    cacheConsistencyService.rebuildUserCaches(userId).catch(() => null);
  }
}

async function addPersonFact(userId, personName, fact) {
  ensureUserId(userId);
  if (!fact || typeof fact !== 'string') {
    throw new Error('Fact is required');
  }

  const profile = await PersonProfile.findOneAndUpdate(
    { userId, nameLower: personName.toLowerCase() },
    { $addToSet: { facts: fact } },
    { upsert: true, returnDocument: 'after' }
  );

  if (profile) {
    cacheConsistencyService.invalidateUserCaches(userId).catch(() => null);
    cacheConsistencyService.rebuildUserCaches(userId).catch(() => null);
  }
}

async function updatePersonImportance(userId, personName, importanceScore) {
  ensureUserId(userId);
  if (typeof importanceScore !== 'number' || importanceScore < 0 || importanceScore > 1) {
    throw new Error('Importance score must be between 0 and 1');
  }

  const profile = await PersonProfile.findOneAndUpdate(
    { userId, nameLower: personName.toLowerCase() },
    { importanceScore },
    { new: true }
  );

  if (profile) {
    cacheConsistencyService.invalidateUserCaches(userId).catch(() => null);
    cacheConsistencyService.rebuildUserCaches(userId).catch(() => null);
  }
}

async function recordPersonMention(userId, personName) {
  ensureUserId(userId);
  const profile = await PersonProfile.findOneAndUpdate(
    { userId, nameLower: personName.toLowerCase() },
    {
      $inc: { mentionCount: 1, accessCount: 1 },
      $set: { lastMentioned: new Date() },
    },
    { upsert: true, returnDocument: 'after' }
  );
  if (profile) {
    cacheConsistencyService.invalidateUserCaches(userId).catch(() => null);
    cacheConsistencyService.rebuildUserCaches(userId).catch(() => null);
  }
}

async function getAllPersonProfiles(userId) {
  ensureUserId(userId);
  return PersonProfile.find({ userId }).sort({ mentionCount: -1 }).lean();
}

async function getMostMentionedPeople(userId, limit = 10) {
  ensureUserId(userId);
  return PersonProfile.find({ userId })
    .sort({ mentionCount: -1 })
    .limit(limit)
    .lean();
}

async function searchPeople(userId, searchTerm) {
  ensureUserId(userId);
  if (!searchTerm || typeof searchTerm !== 'string') {
    return [];
  }

  return PersonProfile.find({
    userId,
    $or: [{ name: new RegExp(searchTerm, 'i') }, { nameLower: searchTerm.toLowerCase() }],
  }).lean();
}

module.exports = {
  upsertPersonProfile,
  getPersonProfile,
  updatePersonRelationship,
  addPersonFact,
  updatePersonImportance,
  recordPersonMention,
  getAllPersonProfiles,
  getMostMentionedPeople,
  searchPeople,
};
