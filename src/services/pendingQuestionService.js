const conversationStateService = require('./conversationStateService');

function extractQuestions(text) {
  if (!text) return [];
  const matches = text.match(/[^.!?\n]+\?/g);
  return matches ? matches.map((q) => q.trim()) : [];
}

async function addPendingQuestions(userId, text) {
  const questions = extractQuestions(text);
  if (!questions.length) return [];

  const state = await conversationStateService.getConversationState(userId);
  const pendingQuestions = Array.from(new Set([...(state.pendingQuestions || []), ...questions]));
  await conversationStateService.updateConversationState(userId, { pendingQuestions });
  return pendingQuestions;
}

async function resolvePendingQuestions(userId, text) {
  const state = await conversationStateService.getConversationState(userId);
  const resolved = state.pendingQuestions || [];
  if (!resolved.length) return [];

  const answeredQuestions = extractQuestions(text);
  const remaining = (state.pendingQuestions || []).filter((question) =>
    !answeredQuestions.some((answer) => answer.toLowerCase().includes(question.toLowerCase()))
  );

  if (remaining.length !== (state.pendingQuestions || []).length) {
    await conversationStateService.updateConversationState(userId, { pendingQuestions: remaining });
  }

  return remaining;
}

module.exports = { addPendingQuestions, resolvePendingQuestions, extractQuestions };