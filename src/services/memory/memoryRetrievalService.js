const { decrypt } = require('../../utils/crypto');
const LongTermMemory = require('../../models/LongTermMemory');

function formatMemory(doc) {
  const memory = decrypt(doc.encryptedMemory);
  return {
    id: String(doc._id),
    category: doc.category,
    memory,
    tags: doc.tags,
    importanceScore: doc.importanceScore,
    createdAt: doc.createdAt,
  };
}

async function retrieveRelevantMemories(userId, query) {
  const docs = await LongTermMemory.find({ userId })
    .sort({ importanceScore: -1 })
    .limit(20)
    .lean();

  const formatted = docs.map(formatMemory);
  if (!query || !String(query).trim()) {
    return formatted.slice(0, 10);
  }

  const normalizedQuery = String(query).trim().toLowerCase();
  return formatted
    .filter((doc) => {
      const text = `${doc.category} ${doc.tags.join(' ')} ${doc.memory}`.toLowerCase();
      return text.includes(normalizedQuery) || normalizedQuery.split(' ').some((term) => text.includes(term));
    })
    .slice(0, 10);
}

async function retrieveCategoryMemories(userId, categories) {
  if (!Array.isArray(categories) || categories.length === 0) return [];

  const docs = await LongTermMemory.find({ userId, category: { $in: categories } })
    .sort({ importanceScore: -1 })
    .limit(50)
    .lean();

  return docs.map(formatMemory);
}

async function retrieveIdentityMemories(userId) {
  return retrieveCategoryMemories(userId, ['identity']);
}

async function retrievePreferenceMemories(userId) {
  return retrieveCategoryMemories(userId, ['preference', 'preferences']);
}

async function retrieveProjectMemories(userId) {
  return retrieveCategoryMemories(userId, ['project', 'projects']);
}

async function retrieveRelationshipMemories(userId) {
  return retrieveCategoryMemories(userId, ['relationship', 'relationships']);
}

async function retrieveGoalMemories(userId) {
  return retrieveCategoryMemories(userId, ['goal', 'goals']);
}

module.exports = {
  retrieveRelevantMemories,
  retrieveIdentityMemories,
  retrievePreferenceMemories,
  retrieveProjectMemories,
  retrieveRelationshipMemories,
  retrieveGoalMemories,
};
