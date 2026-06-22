const tokenBudgetService = require('./tokenBudgetService');
const memoryProfileService = require('./memoryProfileService');
const sessionBootstrapService = require('./sessionBootstrapService');
const sessionMemoryService = require('./sessionMemoryService');
const conversationStateService = require('./conversationStateService');
const unfinishedContextService = require('./unfinishedContextService');
const contextRouterService = require('./contextRouterService');
const relationshipGraphService = require('./relationshipGraphService');
const nameRecallService = require('./nameRecallService');
const continuityService = require('./continuityService');
const memoryGuaranteeService = require('./memoryGuaranteeService');
const memoryIsolationValidator = require('./memoryIsolationValidator');

async function buildContinuityPacket(userId, options = {}) {
  const { userId: safeUserId } = memoryIsolationValidator.validateMemoryOperation({ userId });
  const budgets = tokenBudgetService.allocatePromptBudgets({
    model: options.model,
    totalBudget: options.totalBudget,
    reserved: options.reserved,
  });

  const [profile, bootstrap, activeSession, conversationState, unfinished] = await Promise.all([
    memoryProfileService.getMemoryProfile(safeUserId).catch(() => null),
    sessionBootstrapService.buildSessionBootstrapContext(safeUserId, Boolean(options.forceRefresh)).catch(() => null),
    sessionMemoryService.getActiveSessionMemory(safeUserId).catch(() => null),
    conversationStateService.getConversationState(safeUserId).catch(() => null),
    unfinishedContextService.getPendingContexts(safeUserId, { limit: options.unfinishedLimit || 20 }).catch(() => []),
  ]);

  const userMessage = options.userMessage || (conversationState && conversationState.lastUserMessage) || '';
  const currentTopic = (conversationState && conversationState.currentTopic) || '';

  await memoryGuaranteeService.ensureMemoryGuarantee(safeUserId).catch((err) => {
    console.warn('Memory guarantee validation failed:', err && err.message ? err.message : err);
  });

  const selectedMemories = await contextRouterService.selectRelevantMemories({
    userId: safeUserId,
    userMessage,
    currentTopic,
    conversationState,
    memoryProfile: profile,
    tokenBudget: budgets.relevant,
  }).catch(() => []);

  const relationshipGraph = await relationshipGraphService.buildGraph(safeUserId).catch(() => null);
  const knownNames = await nameRecallService.listKnownNames(safeUserId).catch(() => []);
  const continuityScore = await continuityService.calculateContinuityScore(safeUserId).catch(() => null);

  return {
    userId: safeUserId,
    continuityScore,
    budgets,
    bootstrap,
    profile,
    activeSession,
    conversationState,
    unfinished,
    selectedMemories,
    relationshipGraph,
    knownNames,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildContinuityPacket };
