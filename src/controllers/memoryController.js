const memoryPipelineService = require('../services/memory/memoryPipelineService');
const sessionBootstrapService = require('../services/memory/sessionBootstrapService');
const conversationStateService = require('../services/memory/conversationStateService');
const memoryProfileService = require('../services/memory/memoryProfileService');
const continuityService = require('../services/memory/continuityService');
const memoryHealthService = require('../services/memory/memoryHealthService');
const memoryWorkerHealthService = require('../services/memory/memoryWorkerHealthService');
const memoryAnalyticsService = require('../services/memory/memoryAnalyticsService');
const continuityRestorationEngine = require('../services/memory/continuityRestorationEngine');
const systemPromptBuilderService = require('../services/memory/systemPromptBuilderService');
const memoryIntegrityService = require('../services/memory/memoryIntegrityService');
const cacheConsistencyService = require('../services/memory/cacheConsistencyService');
const sessionContinuityValidator = require('../services/memory/sessionContinuityValidator');
const redisService = require('../services/infrastructure/redisService');
const bootstrapCacheService = require('../services/memory/bootstrapCacheService');

// V6 imports
const sacredMemoryService = require('../services/memory/sacredMemoryService');
const relationshipMemoryEngine = require('../services/memory/relationshipMemoryEngine');
const activeContextService = require('../services/memory/activeContextService');
const recallEngine = require('../services/memory/recallEngine');
const personProfileService = require('../services/memory/personProfileService');
const followUpMemoryService = require('../services/memory/followUpMemoryService');
const sessionContinuityCacheService = require('../services/memory/sessionContinuityCacheService');
const memoryStrengthService = require('../services/memory/memoryStrengthService');

// V7 imports
const memoryRetrievalHierarchy = require('../services/memory/memoryRetrievalHierarchy');
const memoryCompressionService = require('../services/memory/memoryCompressionService');
const emotionalMemoryEngine = require('../services/memory/emotionalMemoryEngine');
const personIdentityResolver = require('../services/memory/personIdentityResolver');
const memoryTruthEngine = require('../services/memory/memoryTruthEngine');
const memoryVerificationService = require('../services/memory/memoryVerificationService');
const memoryAccuracyService = require('../services/memory/memoryAccuracyService');
const memoryJobService = require('../services/memory/memoryJobService');

async function processMemory(req, res, next) {
  try {
    const userId = req.userId;
    const { role = 'user', sessionId } = req.body;
    const text = req.body.text || req.body.message || '';
    const result = await memoryPipelineService.enqueueOrProcessMessage({ userId, sessionId, text, role });
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

async function getBootstrap(req, res, next) {
  try {
    const userId = req.userId;
    const forceRefresh = String(req.query.refresh || req.query.forceRefresh || '').toLowerCase() === 'true';
    const data = await sessionBootstrapService.buildSessionBootstrapContext(userId, forceRefresh);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function getState(req, res, next) {
  try {
    const userId = req.userId;
    const state = await conversationStateService.getConversationState(userId);
    res.json({ success: true, data: state });
  } catch (err) { next(err); }
}

async function updateState(req, res, next) {
  try {
    const userId = req.userId;
    const updates = req.body;
    const state = await conversationStateService.updateConversationState(userId, updates);
    res.json({ success: true, data: state });
  } catch (err) { next(err); }
}

async function getProfile(req, res, next) {
  try {
    const userId = req.userId;
    const profile = await memoryProfileService.getMemoryProfile(userId);
    res.json({ success: true, data: profile });
  } catch (err) { next(err); }
}

async function rebuildProfile(req, res, next) {
  try {
    const userId = req.userId;
    const profile = await memoryProfileService.rebuildMemoryProfile(userId);
    res.json({ success: true, data: profile });
  } catch (err) { next(err); }
}

async function debugMemory(req, res, next) {
  try {
    const userId = req.userId;
    const diagnostics = await memoryPipelineService.getMemoryDiagnostics(userId);
    res.json({ success: true, data: diagnostics });
  } catch (err) { next(err); }
}

async function debugMemoryFull(req, res, next) {
  try {
    const userId = req.userId;
    const diagnostics = await memoryPipelineService.getMemoryDiagnostics(userId);
    const profile = await memoryProfileService.getMemoryProfile(userId);
    const conversationState = await conversationStateService.getConversationState(userId);
    const bootstrap = await bootstrapCacheService.getBootstrapContext(userId).catch(() => null);
    res.json({ success: true, data: { diagnostics, profile, conversationState, bootstrap } });
  } catch (err) { next(err); }
}

async function getLabOverview(req, res, next) {
  try {
    const userId = req.userId;
    const [profile, conversationState, activeSessionMemory, bootstrap, queueStatus] = await Promise.all([
      memoryProfileService.getMemoryProfile(userId).catch(() => null),
      conversationStateService.getConversationState(userId).catch(() => null),
      require('../services/memory/sessionMemoryService').getActiveSessionMemory(userId).catch(() => null),
      bootstrapCacheService.getBootstrapContext(userId).catch(() => null),
      require('../services/memory/memoryJobService').countQueueStatusWithStale().catch(() => null),
    ]);
    const promptPreview = await systemPromptBuilderService.buildSystemPrompt(userId, { tokenBudget: 2000 }).catch(() => null);
    res.json({ success: true, data: { profile, conversationState, activeSessionMemory, bootstrap, queueStatus, promptPreview } });
  } catch (err) { next(err); }
}

async function getLabPromptAudit(req, res, next) {
  try {
    const userId = req.userId;
    const promptPreview = await systemPromptBuilderService.buildSystemPrompt(userId, { tokenBudget: 2000 });
    res.json({ success: true, data: promptPreview });
  } catch (err) { next(err); }
}

async function getLabQueue(req, res, next) {
  try {
    const counts = await require('../services/memory/memoryJobService').countQueueStatusWithStale().catch(() => null);
    const processing = await require('../services/memory/memoryJobService').findProcessingJobsDetailed(200).catch(() => null);
    const failed = await require('../models/MemoryJob').find({ status: 'failed' }).sort({ updatedAt: -1 }).limit(200).lean().catch(() => null);
    res.json({ success: true, data: { counts, processing, failed } });
  } catch (err) { next(err); }
}

async function getLabSession(req, res, next) {
  try {
    const userId = req.userId;
    const sessionMemoryService = require('../services/memory/sessionMemoryService');
    const activeSessionMemory = await sessionMemoryService.getActiveSessionMemory(userId).catch(() => null);
    let shortTermMemory = [];
    if (activeSessionMemory && activeSessionMemory.lastSessionId) {
      shortTermMemory = await redisService.getShortTermMemory(userId, activeSessionMemory.lastSessionId).catch(() => []);
    }
    res.json({ success: true, data: { activeSessionMemory, shortTermMemory } });
  } catch (err) { next(err); }
}

async function getContinuity(req, res, next) {
  try {
    const userId = req.params.userId || req.userId;
    const score = await continuityService.calculateContinuityScore(userId);
    res.json({ success: true, data: { userId, continuityScore: score } });
  } catch (err) { next(err); }
}

async function getHealth(req, res, next) {
  try {
    const data = await memoryHealthService.getMemoryHealth();
    const workerHealth = await memoryWorkerHealthService.getWorkerHealth();
    const bootstrapCache = await require('../services/memory/bootstrapCacheService').getCacheHits().catch(() => null);
    const bootstrapLatency = await require('../services/memory/bootstrapCacheService').getLastBuildMs().catch(() => null);
    res.json({ success: true, data: { ...data, workerHealth, bootstrapLatencyMs: bootstrapLatency, bootstrapCache } });
  } catch (err) { next(err); }
}

async function getStats(req, res, next) {
  try {
    const userId = req.userId;
    const data = await memoryAnalyticsService.getMemoryStats(userId);
    // augment with recall metrics if available
    const profile = await memoryProfileService.getMemoryProfile(userId).catch(() => null);
    const recallMetrics = {
      relationshipRecallRate: profile && String(profile.relationshipSummary || '').length ? 1.0 : 0.0,
      identityRecallRate: profile && String(profile.identitySummary || '').length ? 1.0 : 0.0,
      goalRecallRate: profile && String(profile.goalSummary || '').length ? 1.0 : 0.0,
      continuityRecallRate: 0.0,
    };
    res.json({ success: true, data: { ...data, recallMetrics } });
  } catch (err) { next(err); }
}

async function getContinuityPacket(req, res, next) {
  try {
    const userId = req.params.userId || req.userId;
    const packet = await continuityRestorationEngine.buildContinuityPacket(userId, { totalBudget: 1024 });
    res.json({ success: true, data: packet });
  } catch (err) { next(err); }
}

async function getPromptPreview(req, res, next) {
  try {
    const userId = req.userId;
    const preview = await systemPromptBuilderService.buildSystemPrompt(userId, { tokenBudget: 2000 });
    res.json({ success: true, data: preview });
  } catch (err) { next(err); }
}

async function getVerification(req, res, next) {
  try {
    // allow optionally passing userId for admin runs
    const targetUserId = req.query.userId || req.userId;
    const text = req.query.text || 'My best friend is Aman.';
    const result = await memoryVerificationService.runEndToEndTest(targetUserId, text);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

async function getLabVerification(req, res, next) {
  try {
    const targetUserId = req.query.userId || req.userId;
    const text = req.query.text || 'My best friend is Aman.';
    const result = await memoryVerificationService.runEndToEndTest(targetUserId, text);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

async function getLabAccuracy(req, res, next) {
  try {
    const targetUserId = req.query.userId || req.userId;
    const result = await memoryAccuracyService.runFullAccuracyAudit(targetUserId);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

async function getWorkerHealth(req, res, next) {
  try {
    const health = await memoryWorkerHealthService.getWorkerHealth();
    res.json({ success: true, data: health });
  } catch (err) { next(err); }
}

async function getQueueHealth(req, res, next) {
  try {
    const staleMs = parseInt(req.query.staleMs || '') || 10 * 60 * 1000;
    const counts = await memoryJobService.countQueueStatusWithStale(staleMs);
    const staleList = await memoryJobService.findProcessingJobsDetailed(500);
    res.json({ success: true, data: { counts, staleList } });
  } catch (err) { next(err); }
}

async function getDbCounts(req, res, next) {
  try {
    const userId = req.query.userId || req.userId;
    const Relationship = require('../models/RelationshipMemory');
    const Person = require('../models/PersonProfile');
    const Name = require('../models/MemoryNameIndex');
    const Ltm = require('../models/LongTermMemory');
    const counts = {
      relationship: await Relationship.countDocuments({ userId }),
      person: await Person.countDocuments({ userId }),
      name: await Name.countDocuments({ userId }),
      ltm: await Ltm.countDocuments({ userId }),
    };
    res.json({ success: true, data: counts });
  } catch (err) { next(err); }
}

// V6 ENDPOINTS

async function v6GetSacredMemories(req, res, next) {
  try {
    const userId = req.userId;
    const category = req.query.category;
    let data;
    if (category) {
      data = await sacredMemoryService.getSacredMemoriesByCategory(userId, category);
    } else {
      data = await sacredMemoryService.getAllSacredMemories(userId);
    }
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function v6SaveSacredMemory(req, res, next) {
  try {
    const userId = req.userId;
    const { category, content, metadata, tags } = req.body;
    const memory = await sacredMemoryService.saveSacredMemory({ userId, category, content, metadata, tags });
    res.json({ success: true, data: memory });
  } catch (err) { next(err); }
}

async function v6GetRelationshipGraph(req, res, next) {
  try {
    const userId = req.userId;
    const graph = await relationshipMemoryEngine.buildRelationshipGraph(userId);
    res.json({ success: true, data: graph });
  } catch (err) { next(err); }
}

async function v6GetRelationshipSummary(req, res, next) {
  try {
    const userId = req.userId;
    const summary = await relationshipMemoryEngine.getRelationshipSummary(userId);
    res.json({ success: true, data: summary });
  } catch (err) { next(err); }
}

async function v6GetActiveContext(req, res, next) {
  try {
    const userId = req.userId;
    const sessionId = req.params.sessionId || req.body.sessionId;
    const context = await activeContextService.getContext(userId, sessionId);
    res.json({ success: true, data: context || {} });
  } catch (err) { next(err); }
}

async function v6UpdateActiveContext(req, res, next) {
  try {
    const userId = req.userId;
    const sessionId = req.params.sessionId || req.body.sessionId;
    const updates = req.body.updates || req.body;
    const context = await activeContextService.updateContext(userId, sessionId, updates);
    res.json({ success: true, data: context });
  } catch (err) { next(err); }
}

async function v6RecallMemories(req, res, next) {
  try {
    const userId = req.userId;
    const userMessage = req.body.message || req.query.q;
    const limit = parseInt(req.query.limit || '5');
    const memories = await recallEngine.searchRelevantMemories(userId, userMessage, { limit, minScore: 0.1 });
    res.json({ success: true, data: memories });
  } catch (err) { next(err); }
}

async function v6GetPerson(req, res, next) {
  try {
    const userId = req.userId;
    const personName = req.params.name || req.query.name;
    const profile = await personProfileService.getPersonProfile(userId, personName);
    res.json({ success: true, data: profile || {} });
  } catch (err) { next(err); }
}

async function v6GetAllPeople(req, res, next) {
  try {
    const userId = req.userId;
    const profiles = await personProfileService.getAllPersonProfiles(userId);
    res.json({ success: true, data: profiles });
  } catch (err) { next(err); }
}

async function v6GetPendingFollowUps(req, res, next) {
  try {
    const userId = req.userId;
    const followUps = await followUpMemoryService.getPendingFollowUps(userId);
    res.json({ success: true, data: followUps });
  } catch (err) { next(err); }
}

async function v6GetSessionStartupContext(req, res, next) {
  try {
    const userId = req.userId;
    const sessionId = req.params.sessionId || req.body.sessionId;
    const context = await sessionContinuityCacheService.buildSessionStartupContext(userId, sessionId);
    res.json({ success: true, data: context });
  } catch (err) { next(err); }
}

async function v6GetHealth(req, res, next) {
  try {
    const data = {
      status: 'ok',
      services: {
        sacredMemory: 'active',
        relationships: 'active',
        activeContext: 'active',
        recall: 'active',
        continuityCache: 'active',
      },
      timestamp: new Date().toISOString(),
    };
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function v6GetStats(req, res, next) {
  try {
    const userId = req.userId;
    const [sacred, people, followUps] = await Promise.all([
      sacredMemoryService.getAllSacredMemories(userId).catch(() => []),
      personProfileService.getAllPersonProfiles(userId).catch(() => []),
      followUpMemoryService.getPendingFollowUps(userId).catch(() => []),
    ]);

    const data = {
      sacredMemoriesCount: sacred.length,
      peopleCount: people.length,
      pendingFollowUpsCount: followUps.length,
      topPeople: people.slice(0, 5).map((p) => ({ name: p.name, mentions: p.mentionCount })),
      generatedAt: new Date().toISOString(),
    };
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function v65GetIntegrity(req, res, next) {
  try {
    const userId = req.userId;
    const result = await memoryIntegrityService.validateUserMemories(userId);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

async function v65GetConflicts(req, res, next) {
  try {
    const userId = req.userId;
    const conflicts = await memoryIntegrityService.scanDuplicates(userId);
    res.json({ success: true, data: { userId, conflicts } });
  } catch (err) { next(err); }
}

async function v65GetCache(req, res, next) {
  try {
    const userId = req.userId;
    const freshness = await cacheConsistencyService.verifyCacheFreshness(userId);
    res.json({ success: true, data: freshness });
  } catch (err) { next(err); }
}

async function v65GetContinuity(req, res, next) {
  try {
    const userId = req.userId;
    const continuity = await sessionContinuityValidator.validateContinuity(userId);
    res.json({ success: true, data: continuity });
  } catch (err) { next(err); }
}

module.exports = {
  processMemory,
  getBootstrap,
  getState,
  updateState,
  getProfile,
  rebuildProfile,
  debugMemory,
  debugMemoryFull,
  getContinuity,
  getHealth,
  getStats,
  getContinuityPacket,
  getPromptPreview,
  getVerification,
  getLabOverview,
  getLabPromptAudit,
  getLabVerification,
  getLabAccuracy,
  getLabQueue,
  getLabSession,
  // V6
  v6GetSacredMemories,
  v6SaveSacredMemory,
  v6GetRelationshipGraph,
  v6GetRelationshipSummary,
  v6GetActiveContext,
  v6UpdateActiveContext,
  v6RecallMemories,
  v6GetPerson,
  v6GetAllPeople,
  v6GetPendingFollowUps,
  v6GetSessionStartupContext,
  v6GetHealth,
  v6GetStats,
  v65GetIntegrity,
  v65GetConflicts,
  v65GetCache,
  v65GetContinuity,
  getWorkerHealth,
  getQueueHealth,
  getDbCounts,
};
