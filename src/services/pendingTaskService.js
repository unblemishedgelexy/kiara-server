const conversationStateService = require('./memory/conversationStateService');

function extractTasks(text) {
  if (!text) return [];
  const matches = text.match(/\b(?:todo|task|follow up|implement|finish|complete|next step|remind me|must do)\b[^.!?\n]*/gi);
  return matches ? matches.map((task) => task.trim()) : [];
}

async function addPendingTasks(userId, text) {
  const tasks = extractTasks(text);
  if (!tasks.length) return [];

  const state = await conversationStateService.getConversationState(userId);
  const pendingTasks = Array.from(new Set([...(state.pendingTasks || []), ...tasks]));
  await conversationStateService.updateConversationState(userId, { pendingTasks });
  return pendingTasks;
}

async function resolvePendingTasks(userId, text) {
  const state = await conversationStateService.getConversationState(userId);
  const pendingTasks = state.pendingTasks || [];
  if (!pendingTasks.length) return [];

  const closedPatterns = [/\b(done|completed|finished|resolved|fixed|shipped)\b/i];
  const remaining = pendingTasks.filter((task) =>
    !closedPatterns.some((pattern) => pattern.test(text))
  );

  if (remaining.length !== pendingTasks.length) {
    await conversationStateService.updateConversationState(userId, { pendingTasks: remaining });
  }

  return remaining;
}

module.exports = { addPendingTasks, resolvePendingTasks, extractTasks };