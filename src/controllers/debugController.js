const memoryProfileService = require('../services/../services/memory/memoryProfileService');
const conversationStateService = require('../services/../services/memory/conversationStateService');
const sessionMemoryService = require('../services/../services/memory/sessionMemoryService');
const sessionBootstrapService = require('../services/../services/memory/sessionBootstrapService');

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
