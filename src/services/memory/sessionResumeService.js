const conversationStateService = require('./conversationStateService');
const sessionMemoryService = require('./sessionMemoryService');
const unfinishedContextService = require('./unfinishedContextService');

async function getResumeContext(userId) {
  const conversationState = await conversationStateService.getConversationState(userId);
  const activeSession = await sessionMemoryService.getActiveSessionMemory(userId);
  const unfinished = await unfinishedContextService.getPendingContexts(userId);

  return {
    lastTopic: conversationState.currentTopic || activeSession?.currentTopic || '',
    lastQuestion: conversationState.lastQuestion || activeSession?.lastQuestion || '',
    lastAssistantMessage: conversationState.lastAssistantMessage || activeSession?.lastAssistantMessage || '',
    lastUserMessage: conversationState.lastUserMessage || activeSession?.lastUserMessage || '',
    pendingQuestions: conversationState.pendingQuestions || activeSession?.pendingQuestions || [],
    pendingTasks: conversationState.pendingTasks || activeSession?.pendingTasks || [],
    unfinishedContext: unfinished || [],
    emotion: conversationState.emotion || activeSession?.emotion || '',
    currentTask: conversationState.currentTask || activeSession?.currentTask || '',
  };
}

function buildResumeContext(resumeArgs) {
  const sections = [];
  if (resumeArgs.lastTopic) {
    sections.push(`Topic:\n${resumeArgs.lastTopic}`);
  }
  if (resumeArgs.lastQuestion) {
    sections.push(`Last Question:\n${resumeArgs.lastQuestion}`);
  }
  if (resumeArgs.pendingTasks?.length) {
    sections.push(`Pending Tasks:\n${resumeArgs.pendingTasks.join('\n')}`);
  }
  if (resumeArgs.pendingQuestions?.length) {
    sections.push(`Pending Questions:\n${resumeArgs.pendingQuestions.join('\n')}`);
  }
  if (resumeArgs.currentTask) {
    sections.push(`Current Task:\n${resumeArgs.currentTask}`);
  }
  if (resumeArgs.unfinishedContext?.length) {
    sections.push(`Unfinished Context:\n${resumeArgs.unfinishedContext.map((item) => item.question).join('\n')}`);
  }
  if (resumeArgs.lastAssistantMessage) {
    sections.push(`Previous Assistant Message:\n${resumeArgs.lastAssistantMessage}`);
  }
  if (resumeArgs.lastUserMessage) {
    sections.push(`Previous User Message:\n${resumeArgs.lastUserMessage}`);
  }
  if (resumeArgs.emotion) {
    sections.push(`Detected Emotion:\n${resumeArgs.emotion}`);
  }

  return sections.filter(Boolean).join('\n\n').trim();
}

module.exports = { getResumeContext, buildResumeContext };