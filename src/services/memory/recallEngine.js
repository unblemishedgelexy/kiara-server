const LongTermMemory = require('../../models/LongTermMemory');
const SacredMemory = require('../../models/SacredMemory');
const { decrypt } = require('../../utils/crypto');
const { ensureUserId } = require('../../utils/ensureUserId');

function scoreRelevance(memoryText, userMessage, metadata = {}) {
  if (!memoryText || !userMessage) return 0;

  const msg = String(userMessage).toLowerCase();
  const text = String(memoryText).toLowerCase();

  let score = 0;

  // Exact match boost
  if (text.includes(msg) || msg.includes(text)) score += 0.4;

  // Token overlap
  const msgTokens = new Set(msg.split(/\W+/).filter(Boolean));
  const textTokens = new Set(text.split(/\W+/).filter(Boolean));
  const common = [...msgTokens].filter((t) => textTokens.has(t)).length;
  const overlap = common / Math.max(1, Math.min(msgTokens.size, textTokens.size));
  score += overlap * 0.3;

  // Strength bonus
  if (metadata.strength) {
    score += (metadata.strength.memoryStrength || 0) * 0.15;
    score += (metadata.strength.importanceScore || 0) * 0.15;
  }

  return Math.min(1, score);
}

async function searchRelevantMemories(userId, userMessage, options = {}) {
  ensureUserId(userId);
  if (!userMessage || typeof userMessage !== 'string') {
    return [];
  }

  const limit = options.limit || 5;
  const minScore = options.minScore || 0.1;
  const categories = options.categories || null;

  // Search both sacred and long-term memories
  const query = { userId };
  if (categories) {
    query.category = { $in: Array.isArray(categories) ? categories : [categories] };
  }

  const [sacredMemories, ltmMemories] = await Promise.all([
    SacredMemory.find(query).lean(),
    LongTermMemory.find(query).lean(),
  ]);

  const allMemories = [...sacredMemories, ...ltmMemories].map((m) => ({
    ...m,
    source: m.constructor.modelName === 'SacredMemory' ? 'sacred' : 'ltm',
  }));

  const scored = allMemories
    .map((m) => {
      let text = m.content;
      try {
        if (m.encryptedContent) text = decrypt(m.encryptedContent);
        else if (m.encryptedMemory) text = decrypt(m.encryptedMemory);
      } catch (e) {
        // Use original text if decryption fails
      }

      return {
        _id: m._id,
        category: m.category,
        content: text,
        metadata: m.metadata || {},
        strength: m.strength || {},
        source: m.source,
        score: scoreRelevance(text, userMessage, m.strength),
      };
    })
    .filter((m) => m.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored;
}

async function findRelationshipMemories(userId, personName) {
  ensureUserId(userId);
  if (!personName || typeof personName !== 'string') {
    return [];
  }

  const query = {
    userId,
    $or: [
      { 'metadata.personName': new RegExp(personName, 'i') },
      { content: new RegExp(personName, 'i') },
    ],
  };

  const [sacred, ltm] = await Promise.all([SacredMemory.find(query).lean(), LongTermMemory.find(query).lean()]);

  return [...sacred, ...ltm]
    .map((m) => {
      let text = m.content;
      try {
        if (m.encryptedContent) text = decrypt(m.encryptedContent);
        else if (m.encryptedMemory) text = decrypt(m.encryptedMemory);
      } catch (e) {
        // Use original text
      }

      return {
        _id: m._id,
        category: m.category,
        content: text,
        personName: m.metadata?.personName,
        strength: m.strength || {},
      };
    })
    .sort((a, b) => (b.strength.memoryStrength || 0) - (a.strength.memoryStrength || 0));
}

async function findProjectMemories(userId, projectName) {
  ensureUserId(userId);
  if (!projectName || typeof projectName !== 'string') {
    return [];
  }

  const query = {
    userId,
    category: 'project',
    $or: [
      { content: new RegExp(projectName, 'i') },
      { 'metadata.projectName': new RegExp(projectName, 'i') },
    ],
  };

  const memories = await SacredMemory.find(query).lean();
  return memories.map((m) => ({
    _id: m._id,
    category: m.category,
    content: m.content,
    metadata: m.metadata,
    strength: m.strength,
  }));
}

async function findGoalMemories(userId, goalKeyword) {
  ensureUserId(userId);
  if (!goalKeyword || typeof goalKeyword !== 'string') {
    return [];
  }

  const query = {
    userId,
    category: 'goal',
    $or: [{ content: new RegExp(goalKeyword, 'i') }, { 'metadata.goalName': new RegExp(goalKeyword, 'i') }],
  };

  const memories = await SacredMemory.find(query).lean();
  return memories.map((m) => ({
    _id: m._id,
    category: m.category,
    content: m.content,
    metadata: m.metadata,
    strength: m.strength,
  }));
}

async function findFactMemories(userId, factKeyword) {
  ensureUserId(userId);
  if (!factKeyword || typeof factKeyword !== 'string') {
    return [];
  }

  const query = {
    userId,
    category: { $in: ['life_fact', 'identity', 'family'] },
    content: new RegExp(factKeyword, 'i'),
  };

  const memories = await SacredMemory.find(query).lean();
  return memories.map((m) => ({
    _id: m._id,
    category: m.category,
    content: m.content,
    strength: m.strength,
  }));
}

module.exports = {
  searchRelevantMemories,
  findRelationshipMemories,
  findProjectMemories,
  findGoalMemories,
  findFactMemories,
};
