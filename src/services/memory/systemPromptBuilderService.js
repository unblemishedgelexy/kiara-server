const memoryRetrievalService = require('./memoryRetrievalService');
const memoryProfileService = require('./memoryProfileService');
const sessionBootstrapService = require('./sessionBootstrapService');
const sessionMemoryService = require('./sessionMemoryService');
const redisService = require('../infrastructure/redisService');
const memoryContextAssembler = require('./memoryContextAssembler');
const memoryCompressionService = require('./memoryCompressionService');
const { env } = require('../../config/env');

function estimateTokens(text) {
  if (!text) return 0;
  const words = String(text).trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words / 0.75);
}

async function buildIdentitySection(userId, limit = 10) {
  const items = await memoryRetrievalService.retrieveIdentityMemories(userId).catch(() => []);
  return items.slice(0, limit).map((m) => `- ${m.memory}`).join('\n');
}

async function buildPreferenceSection(userId, limit = 10) {
  const items = await memoryRetrievalService.retrievePreferenceMemories(userId).catch(() => []);
  return items.slice(0, limit).map((m) => `- ${m.memory}`).join('\n');
}

async function buildRelationshipSection(userId, limit = 20) {
  const items = await memoryRetrievalService.retrieveRelationshipMemories(userId).catch(() => []);
  return items.slice(0, limit).map((m) => `- ${m.memory}`).join('\n');
}

async function buildProjectSection(userId, limit = 10) {
  const items = await memoryRetrievalService.retrieveProjectMemories(userId).catch(() => []);
  return items.slice(0, limit).map((m) => `- ${m.memory}`).join('\n');
}

async function buildGoalSection(userId, limit = 10) {
  const items = await memoryRetrievalService.retrieveGoalMemories(userId).catch(() => []);
  return items.slice(0, limit).map((m) => `- ${m.memory}`).join('\n');
}

async function buildSessionSection(userId) {
  const state = await require('./conversationStateService').getConversationState(userId).catch(() => null);
  if (!state) return '';
  const lines = [];
  if (state.currentTopic) lines.push(`Last Topic: ${state.currentTopic}`);
  if (state.lastQuestion) lines.push(`Last Question: ${state.lastQuestion}`);
  if (state.pendingTasks && state.pendingTasks.length) lines.push(`Pending Tasks: ${state.pendingTasks.join('; ')}`);
  if (state.pendingQuestions && state.pendingQuestions.length) lines.push(`Pending Questions: ${state.pendingQuestions.join('; ')}`);
  if (state.emotion) lines.push(`Current Emotion: ${state.emotion}`);
  return lines.join('\n');
}

async function buildRelevantMemorySection(userId, tokenBudget = 1200, limits = {}) {
  // Assemble candidate memories from STM+LTM+profile
  const assembled = await memoryContextAssembler.assembleMemoryContext(userId, { tokenBudget }).catch(() => ({ memories: [] }));
  const memories = assembled.memories || [];

  // Apply per-category caps
  const caps = Object.assign({ identity: 10, preference: 10, relationship: 20, project: 10, goal: 10 }, limits);
  const categoryCounters = {};
  const selected = [];
  const droppedByCategory = {};
  let droppedCount = 0;

  for (const m of memories) {
    const cat = m.category || 'other';
    categoryCounters[cat] = categoryCounters[cat] || 0;
    if (categoryCounters[cat] < (caps[cat] || 10)) {
      selected.push(m);
      categoryCounters[cat] += 1;
    } else {
      droppedCount += 1;
      droppedByCategory[cat] = (droppedByCategory[cat] || 0) + 1;
    }
  }

  const text = selected.map((m) => `- ${m.category}: ${m.memory}`).join('\n');
  const tokens = estimateTokens(text);
  const summary = {
    retrievedCount: memories.length,
    selectedCount: selected.length,
    droppedCount,
    droppedByCategory,
    perCategoryCap: caps,
    tokenBudget,
    tokenCount: tokens,
    compressed: false,
  };

  if (tokens > tokenBudget) {
    const compressed = memoryCompressionService.compressMemories(selected, { perCategory: caps });
    const compressedTokenCount = estimateTokens(compressed);
    return {
      text: compressed,
      tokenCount: compressedTokenCount,
      memories: selected,
      memoryAudit: {
        ...summary,
        tokenCount: compressedTokenCount,
        compressed: true,
        compressionApplied: true,
        compressionReason: 'token_budget_exceeded',
      },
    };
  }

  return {
    text,
    tokenCount: tokens,
    memories: selected,
    memoryAudit: summary,
  };
}

async function buildSystemPrompt(userId, opts = {}) {
  const tokenBudget = opts.tokenBudget || 2000;
  const identity = await buildIdentitySection(userId, 10);
  const preferences = await buildPreferenceSection(userId, 10);
  const relationships = await buildRelationshipSection(userId, 20);
  const projects = await buildProjectSection(userId, 10);
  const goals = await buildGoalSection(userId, 10);
  const session = await buildSessionSection(userId);
  const relevant = await buildRelevantMemorySection(userId, tokenBudget);

  const parts = [];
  parts.push('You are Kiara.');
  if (identity) parts.push(`Identity:\n${identity}`);
  if (preferences) parts.push(`Preferences:\n${preferences}`);
  if (relationships) parts.push(`Relationships:\n${relationships}`);
  if (projects) parts.push(`Projects:\n${projects}`);
  if (goals) parts.push(`Goals:\n${goals}`);
  if (session) parts.push(`Current Session:\n${session}`);
  if (relevant && relevant.text) parts.push(`Relevant Memories:\n${relevant.text}`);

  const systemPrompt = parts.filter(Boolean).join('\n\n');
  const tokenCount = estimateTokens(systemPrompt);
  const memoryCount = (relevant.memories || []).length + (identity ? identity.split('\n').length : 0);
  console.log('[PROMPT_BUILD_SUCCESS]', { userId, containsName: String(systemPrompt || '').toLowerCase().includes('aman') });
  return {
    systemPrompt,
    tokenCount,
    memoryCount,
    selectedMemories: relevant.memories || [],
    memoryAudit: relevant.memoryAudit || null,
  };
}

module.exports = {
  buildSystemPrompt,
  buildIdentitySection,
  buildPreferenceSection,
  buildRelationshipSection,
  buildProjectSection,
  buildGoalSection,
  buildSessionSection,
  buildRelevantMemorySection,
};
