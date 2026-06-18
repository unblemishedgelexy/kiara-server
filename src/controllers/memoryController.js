const memoryPipelineService = require('../services/memoryPipelineService');
const sessionBootstrapService = require('../services/sessionBootstrapService');
const conversationStateService = require('../services/conversationStateService');
const memoryProfileService = require('../services/memoryProfileService');
const continuityService = require('../services/continuityService');
const memoryHealthService = require('../services/memoryHealthService');
const memoryAnalyticsService = require('../services/memoryAnalyticsService');
const continuityRestorationService = require('../services/continuityRestorationService');

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
    const data = await sessionBootstrapService.buildSessionBootstrapContext(userId);
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
    const bootstrap = await require('../services/bootstrapCacheService').getBootstrapContext(userId).catch(() => null);
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
