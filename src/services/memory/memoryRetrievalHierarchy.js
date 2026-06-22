const { ensureUserId } = require('../../utils/ensureUserId');
const SacredMemory = require('../../models/SacredMemory');
const IdentityMemory = require('../../models/IdentityMemory');
const RelationshipMemory = require('../../models/RelationshipMemory');
const GoalMemory = require('../../models/GoalMemory');
const ProjectMemory = require('../../models/ProjectMemory');
const EpisodicMemory = require('../../models/EpisodicMemory');
const LongTermMemory = require('../../models/LongTermMemory');
const ActiveContext = require('../../models/ActiveContext');

/**
 * Memory Retrieval Hierarchy (V7)
 * Standardized retrieval order across all memory types.
 * Priority: Sacred > Identity > Relationship > Goal > Project > Emotional > Context > Session > LTM
 */

const RETRIEVAL_ORDER = [
  { type: 'SacredMemory', model: SacredMemory, priority: 10 },
  { type: 'IdentityMemory', model: IdentityMemory, priority: 9 },
  { type: 'RelationshipMemory', model: RelationshipMemory, priority: 8 },
  { type: 'GoalMemory', model: GoalMemory, priority: 7 },
  { type: 'ProjectMemory', model: ProjectMemory, priority: 6 },
  { type: 'EpisodicMemory', model: EpisodicMemory, priority: 5 },
  { type: 'ActiveContext', model: ActiveContext, priority: 4 },
  // Session memory is managed via sessionMemoryService (redis/in-memory) and is not a Mongo model
  { type: 'LongTermMemory', model: LongTermMemory, priority: 2 },
];

async function retrieveByHierarchy(userId, query, options = {}) {
  ensureUserId(userId);

  const { limit = 5, minScore = 0.1 } = options;
  const results = [];

  for (const layer of RETRIEVAL_ORDER) {
    if (results.length >= limit) break;

    try {
      const docs = await layer.model
        .find({ userId, ...query })
        .select('_id category confidence importanceScore lastAccessed')
        .limit(limit - results.length)
        .lean();

      for (const doc of docs) {
        const confidence = doc.confidence || 0;
        if (confidence >= minScore) {
          results.push({
            type: layer.type,
            id: doc._id,
            priority: layer.priority,
            confidence,
            importance: doc.importanceScore || 0.5,
            lastAccessed: doc.lastAccessed,
          });
        }
      }
    } catch (err) {
      console.warn(`Failed to retrieve from ${layer.type}:`, err.message);
    }
  }

  // Sort by priority (descending) and then by confidence
  results.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.confidence - a.confidence;
  });

  return results.slice(0, limit);
}

async function retrieveMemoriesWithContext(userId, topic, options = {}) {
  ensureUserId(userId);

  const { limit = 10, minScore = 0.1, relevanceThreshold = 0.3 } = options;
  
  // First get active context
  const activeContext = await ActiveContext.findOne({ userId }).lean();
  
  // Then retrieve from hierarchy
  const memories = await retrieveByHierarchy(
    userId,
    { $or: [{ tags: topic }, { 'metadata.personName': topic }] },
    { limit, minScore }
  );

  // Return with context
  return {
    activeContext,
    memories,
    totalRetrieved: memories.length,
    fromHierarchy: true,
  };
}

async function retrieveForBootstrap(userId, options = {}) {
  ensureUserId(userId);

  const { tokenBudget = 2000 } = options;
  const result = {
    identity: null,
    relationships: [],
    goals: [],
    projects: [],
    activeContext: null,
    timestamp: new Date(),
  };

  // 1. Get identity (SacredMemory priority)
  try {
    const sacred = await SacredMemory.findOne({ userId, category: 'identity', active: true })
      .select('content metadata')
      .lean();
    if (sacred) {
      result.identity = { type: 'SacredMemory', content: sacred.content };
    } else {
      const identity = await IdentityMemory.findOne({ userId, active: true })
        .select('encryptedMemory')
        .lean();
      if (identity) {
        result.identity = { type: 'IdentityMemory', id: identity._id };
      }
    }
  } catch (err) {
    console.error('Error retrieving identity:', err);
  }

  // 2. Get relationships
  try {
    const relationships = await RelationshipMemory.find({ userId, active: true })
      .select('personProfileName metadata lastAccessed mentionCount')
      .sort({ lastAccessed: -1 })
      .limit(5)
      .lean();
    result.relationships = relationships;
  } catch (err) {
    console.error('Error retrieving relationships:', err);
  }

  // 3. Get goals
  try {
    const goals = await GoalMemory.find({ userId, active: true })
      .select('encryptedMemory category lastAccessed')
      .sort({ importanceScore: -1 })
      .limit(3)
      .lean();
    result.goals = goals;
  } catch (err) {
    console.error('Error retrieving goals:', err);
  }

  // 4. Get projects
  try {
    const projects = await ProjectMemory.find({ userId, active: true })
      .select('encryptedMemory lastAccessed importanceScore')
      .sort({ lastAccessed: -1 })
      .limit(2)
      .lean();
    result.projects = projects;
  } catch (err) {
    console.error('Error retrieving projects:', err);
  }

  // 5. Get active context
  try {
    const context = await ActiveContext.findOne({ userId })
      .select('currentTopic lastQuestion pendingQuestions currentEmotion')
      .lean();
    if (context) {
      result.activeContext = context;
    }
  } catch (err) {
    console.error('Error retrieving active context:', err);
  }

  return result;
}

async function retrieveForContinuity(userId) {
  ensureUserId(userId);

  const context = await ActiveContext.findOne({ userId }).lean();
  if (!context) return null;

  // Retrieve from hierarchy based on current topic
  const memories = await retrieveByHierarchy(
    userId,
    { tags: { $in: [context.currentTopic, context.currentGoal].filter(Boolean) } },
    { limit: 3 }
  );

  return {
    topic: context.currentTopic,
    lastQuestion: context.lastQuestion,
    pendingQuestions: context.pendingQuestions || [],
    pendingTasks: context.pendingTasks || [],
    emotion: context.currentEmotion,
    memories,
  };
}

module.exports = {
  retrieveByHierarchy,
  retrieveMemoriesWithContext,
  retrieveForBootstrap,
  retrieveForContinuity,
  RETRIEVAL_ORDER,
};
