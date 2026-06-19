const conversationStateService = require('./conversationStateService');
const memoryProfileService = require('./memoryProfileService');

function normalizeScore(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

async function calculateContinuityScore(userId) {
  const state = await conversationStateService.getConversationState(userId);
  const profile = await memoryProfileService.getMemoryProfile(userId);

  const identityRecall = normalizeScore(profile?.identitySummary ? 1 : 0);
  const preferenceRecall = normalizeScore(profile?.preferenceSummary ? 1 : 0);
  const topicRecall = normalizeScore(state?.currentTopic ? 1 : 0);
  const taskRecall = normalizeScore((state?.pendingTasks?.length || 0) > 0 ? 1 : 0);
  const questionRecall = normalizeScore((state?.pendingQuestions?.length || 0) > 0 ? 1 : 0);

  const weighted = (
    identityRecall * 0.2 +
    preferenceRecall * 0.2 +
    topicRecall * 0.2 +
    taskRecall * 0.2 +
    questionRecall * 0.2
  );

  return Math.round(weighted * 100);
}

module.exports = { calculateContinuityScore };