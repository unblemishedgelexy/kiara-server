const { env } = require('../../config/env');

function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.max(0, Math.ceil(String(text).trim().split(/\s+/).filter(Boolean).length * 0.75));
}

function getModelTokenLimit(modelName) {
  const model = String(modelName || env.geminiLiveModel || '').toLowerCase();
  if (model.includes('live')) return 3400;
  if (model.includes('gemini-2.5')) return 3800;
  if (model.includes('gemini-3')) return 4096;
  return 3500;
}

function allocatePromptBudgets(options = {}) {
  const totalBudget = Number(options.totalBudget) || getModelTokenLimit(options.model);
  const reserved = Number(options.reserved) || 400;
  const available = Math.max(0, totalBudget - reserved);
  const ratios = {
    identity: 0.12,
    preferences: 0.10,
    relationships: 0.16,
    projects: 0.12,
    goals: 0.10,
    session: 0.10,
    relevant: 0.30,
  };

  const budgets = Object.fromEntries(
    Object.entries(ratios).map(([key, ratio]) => [key, Math.max(50, Math.floor(available * ratio))])
  );

  return {
    totalBudget,
    reserved,
    available,
    ...budgets,
  };
}

function shrinkToBudget(text, maxTokens) {
  if (!text || !maxTokens) return '';
  const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length <= maxTokens) return text.trim();
  return tokens.slice(0, maxTokens).join(' ');
}

module.exports = {
  estimateTokens,
  getModelTokenLimit,
  allocatePromptBudgets,
  shrinkToBudget,
};
