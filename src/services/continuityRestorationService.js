const sessionBootstrapService = require('./sessionBootstrapService');
const sessionMemoryService = require('./sessionMemoryService');
const conversationStateService = require('./conversationStateService');
const unfinishedContextService = require('./unfinishedContextService');
const contextRouterService = require('./contextRouterService');

async function buildContinuityPacket(userId, options = {}) {
  const bootstrap = await sessionBootstrapService.buildSessionBootstrapContext(userId).catch(() => null);
  const activeSession = await sessionMemoryService.getActiveSessionMemory(userId).catch(() => null);
  const unfinished = await unfinishedContextService.getUnfinishedContexts(userId).catch(() => []);
  const conversationState = await conversationStateService.getConversationState(userId).catch(() => null);
  const profile = await require('./memoryProfileService').getMemoryProfile(userId).catch(() => null);

  const userMessage = options.userMessage || (conversationState && conversationState.lastUserMessage) || '';
  const currentTopic = (conversationState && conversationState.currentTopic) || '';

  const selectedMemories = await contextRouterService.selectRelevantMemories({
    userId,
    userMessage,
    currentTopic,
    conversationState,
    memoryProfile: profile,
    tokenBudget: options.tokenBudget || 1024,
  }).catch(() => []);

  return {
    bootstrap,
    activeSession,
    unfinished,
    conversationState,
    selectedMemories,
  };
}

module.exports = { buildContinuityPacket };
