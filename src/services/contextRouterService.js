const LongTermMemory = require('../models/LongTermMemory');
const ShortTermMemory = require('../models/ShortTermMemory');
const _ = require('lodash');

function simpleRelevanceScore(memText, userMessage) {
  if (!memText || !userMessage) return 0;
  const msg = String(userMessage).toLowerCase();
  const text = String(memText).toLowerCase();
  let score = 0;
  // exact substring match boosts
  if (text.includes(msg) || msg.includes(text)) score += 0.6;
  // token overlap
  const msgTokens = new Set(msg.split(/\W+/).filter(Boolean));
  const textTokens = new Set(text.split(/\W+/).filter(Boolean));
  const common = [...msgTokens].filter((t) => textTokens.has(t)).length;
  const overlap = common / Math.max(1, Math.min(msgTokens.size, textTokens.size));
  score += Math.min(0.4, overlap * 0.4);
  return Math.max(0, Math.min(1, score));
}

function estimateTokensForText(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

async function selectRelevantMemories({ userId, userMessage = '', currentTopic = '', conversationState = {}, memoryProfile = {}, tokenBudget = 1024, categoryWeights = {} }) {
  // load candidate memories: short-term first then long-term
  const shortCandidates = await ShortTermMemory.find({ userId }).lean().limit(50).catch(() => []);
  const longCandidates = await LongTermMemory.find({ userId }).lean().limit(200).catch(() => []);

  const all = [...shortCandidates, ...longCandidates];
  const scored = all.map((m) => {
    const memText = m.encryptedMemory || m.content || '';
    const relevance = simpleRelevanceScore(memText, userMessage) + (currentTopic && String(m.tags || []).join(' ').toLowerCase().includes(String(currentTopic).toLowerCase()) ? 0.2 : 0);
    const confidence = typeof m.confidence === 'number' ? m.confidence : 0.5;
    const importance = typeof m.importanceScore === 'number' ? m.importanceScore : m.importance || 0.5;
    const category = m.category || 'other';
    const catWeight = categoryWeights[category] || (category === 'identity' || category === 'preference' ? 1.2 : 1.0);
    const score = (relevance * 0.6 + confidence * 0.3 + importance * 0.1) * catWeight;
    const tokens = estimateTokensForText(memText);
    return { doc: m, score, tokens };
  });

  const sorted = _.orderBy(scored, ['score'], ['desc']);
  const selected = [];
  let remaining = tokenBudget;
  for (const s of sorted) {
    if (s.score <= 0) break;
    if (s.tokens > remaining) continue;
    selected.push(s.doc);
    remaining -= s.tokens;
    if (remaining <= 0) break;
  }
  return selected;
}

module.exports = { selectRelevantMemories };
