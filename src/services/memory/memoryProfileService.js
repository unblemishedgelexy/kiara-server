const { env } = require('../../config/env');
const MemoryProfile = require('../../models/MemoryProfile');
const memoryRetrievalService = require('./memoryRetrievalService');
const profileCacheService = require('../infrastructure/profileCacheService');

function buildSummary(memories, header) {
  if (!Array.isArray(memories) || memories.length === 0) return '';
  const lines = memories.slice(0, 5).map((memory) => `- ${memory.memory}`);
  return `${header}:\n${lines.join('\n')}`;
}

async function getMemoryProfile(userId) {
  if (!userId) return null;

  if (env.enableProfileCache) {
    const cached = await profileCacheService.getProfileCache(userId);
    if (cached && cached.bootstrapVersion === env.bootstrapVersion) {
      return cached;
    }
  }

  let profile = await MemoryProfile.findOne({ userId }).lean();
  if (!profile) {
    return rebuildMemoryProfile(userId);
  }

  if (profile.bootstrapVersion !== env.bootstrapVersion) {
    return rebuildMemoryProfile(userId);
  }

  if (env.enableProfileCache) {
    await profileCacheService.saveProfileCache(userId, profile).catch(() => null);
  }

  return profile;
}

async function rebuildMemoryProfile(userId) {
  const [identity, preferences, relationships, projects, goals] = await Promise.all([
    memoryRetrievalService.retrieveIdentityMemories(userId),
    memoryRetrievalService.retrievePreferenceMemories(userId),
    memoryRetrievalService.retrieveRelationshipMemories(userId),
    memoryRetrievalService.retrieveProjectMemories(userId),
    memoryRetrievalService.retrieveGoalMemories(userId),
  ]);

  const identitySummary = buildSummary(identity, 'Identity Summary');
  const preferenceSummary = buildSummary(preferences, 'Preference Summary');
  const relationshipSummary = buildSummary(relationships, 'Relationship Summary');
  const projectSummary = buildSummary(projects, 'Project Summary');
  const goalSummary = buildSummary(goals, 'Goal Summary');

  const profile = await MemoryProfile.findOneAndUpdate(
    { userId },
    {
      identitySummary,
      preferenceSummary,
      relationshipSummary,
      projectSummary,
      goalSummary,
      bootstrapVersion: env.bootstrapVersion,
      lastUpdated: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  if (env.enableProfileCache) {
    await profileCacheService.saveProfileCache(userId, profile).catch(() => null);
  }

  return profile;
}

module.exports = { getMemoryProfile, rebuildMemoryProfile };