const memoryPipelineService = require('../services/memory/memoryPipelineService');
const sessionBootstrapService = require('../services/memory/sessionBootstrapService');
const conversationStateService = require('../services/memory/conversationStateService');
const memoryProfileService = require('../services/memory/memoryProfileService');
const continuityService = require('../services/memory/continuityService');
const memoryHealthService = require('../services/memory/memoryHealthService');
const memoryAnalyticsService = require('../services/memory/memoryAnalyticsService');
const continuityRestorationService = require('../services/memory/continuityRestorationService');

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
    const bootstrap = await require('../services/memory/bootstrapCacheService').getBootstrapContext(userId).catch(() => null);
    res.json({ success: true, data: { diagnostics, profile, conversationState, bootstrap } });
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
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function getStats(req, res, next) {
  try {
    const userId = req.userId;
    const data = await memoryAnalyticsService.getMemoryStats(userId);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function getContinuityPacket(req, res, next) {
  try {
    const userId = req.params.userId || req.userId;
    const packet = await continuityRestorationService.buildContinuityPacket(userId, { tokenBudget: 1024 });
    res.json({ success: true, data: packet });
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
};
