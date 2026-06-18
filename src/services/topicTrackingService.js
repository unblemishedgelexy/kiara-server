const conversationStateService = require('./conversationStateService');

function detectTopic(text) {
  if (!text) return '';
  const normalized = String(text).toLowerCase();
  if (/\b(pip|picture-in-picture|video overlay|floating window)\b/.test(normalized)) return 'Android PiP';
  if (/\b(profile|name|identity|bio)\b/.test(normalized)) return 'Personal Profile';
  if (/\b(project|deadline|milestone|launch)\b/.test(normalized)) return 'Project Work';
  if (/\b(goal|objective|target)\b/.test(normalized)) return 'Goals';
  if (/\b(family|friend|relationship|partner)\b/.test(normalized)) return 'Relationship';
  return '';
}

async function updateCurrentTopic(userId, text) {
  const currentTopic = detectTopic(text);
  if (!currentTopic) return null;
  const state = await conversationStateService.getConversationState(userId);
  if (state.currentTopic !== currentTopic) {
    const previousTopics = Array.from(new Set([...(state.previousTopics || []), state.currentTopic].filter(Boolean)));
    await conversationStateService.updateConversationState(userId, { currentTopic, previousTopics });
  }
  return currentTopic;
}

async function closeTopic(userId) {
  const state = await conversationStateService.getConversationState(userId);
  const previousTopics = Array.from(new Set([...(state.previousTopics || []), state.currentTopic].filter(Boolean)));
  await conversationStateService.updateConversationState(userId, { currentTopic: '', previousTopics });
  return previousTopics;
}

async function trackTopicTransitions(userId, text) {
  const state = await conversationStateService.getConversationState(userId);
  const detected = detectTopic(text);
  if (detected && state.currentTopic !== detected) {
    const previousTopics = Array.from(new Set([...(state.previousTopics || []), state.currentTopic].filter(Boolean)));
    await conversationStateService.updateConversationState(userId, { currentTopic: detected, previousTopics });
    return { from: state.currentTopic, to: detected };
  }
  return { from: state.currentTopic, to: state.currentTopic };
}

module.exports = {
  detectTopic,
  updateCurrentTopic,
  closeTopic,
  trackTopicTransitions,
};