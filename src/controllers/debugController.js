const memoryProfileService = require('../services/memoryProfileService');
const conversationStateService = require('../services/conversationStateService');
const sessionMemoryService = require('../services/sessionMemoryService');
const sessionBootstrapService = require('../services/sessionBootstrapService');

async function debugOverview(req, res, next) {
  try {
    const userId = req.userId;
    const profile = await memoryProfileService.getMemoryProfile(userId).catch(() => null);
    const state = await conversationStateService.getConversationState(userId).catch(() => null);
    const active = await sessionMemoryService.getActiveSessionMemory(userId).catch(() => null);
    const bootstrap = await sessionBootstrapService.buildSessionBootstrapContext(userId).catch(() => null);
    res.json({ success: true, data: { profile, state, active, bootstrap } });
  } catch (e) { next(e); }
}

module.exports = { debugOverview };
