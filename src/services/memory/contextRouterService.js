const LongTermMemory = require('../../models/LongTermMemory');
const _ = require('lodash');
const { decrypt } = require('../../utils/crypto');

function simpleRelevanceScore(memText, userMessage) {
  if (!memText || !userMessage) return 0;
  const msg = String(userMessage).toLowerCase();
  const text = String(memText).toLowerCase();
  let score = 0;
  if (text.includes(msg) || msg.includes(text)) score += 0.6;
  const msgTokens = new Set(msg.split(/\W+/).filter(Boolean));
  const textTokens = new Set(text.split(/\W+/).filter(Boolean));
  const common = [...msgTokens].filter((t) => textTokens.has(t)).length;
  const overlap = common / Math.max(1, Math.min(msgTokens.size, textTokens.size));
  score += Math.min(0.4, overlap * 0.4);
  return Math.max(0, Math.min(1, score));
}

function getMemoryText(doc) {
  if (!doc) return '';
  if (typeof doc.content === 'string' && doc.content.trim()) return doc.content.trim();
  if (typeof doc.encryptedMemory === 'string' && doc.encryptedMemory.trim()) {
    try {
      return decrypt(doc.encryptedMemory);
    } catch (error) {
      console.warn('ContextRouter: failed to decrypt memory text for scoring', error.message || error);
      return '';
    }
  }
  return '';
}

function estimateTokensForText(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

async function selectRelevantMemories({ userId, userMessage = '', currentTopic = '', conversationState = {}, memoryProfile = {}, tokenBudget = 1024, categoryWeights = {}, minConfidence = 0.25 }) {
  const longCandidates = await LongTermMemory.find({ userId }).lean().limit(200).catch(() => []);

  const all = [...longCandidates];
  const scored = all
    .map((m) => {
      const memText = getMemoryText(m);
      if (!memText) return null;
      const confidence = typeof m.confidence === 'number' ? m.confidence : 0.5;
      if (confidence < minConfidence) return null;
      const importance = typeof m.importanceScore === 'number' ? m.importanceScore : m.importance || 0.5;
      const topicMatch = currentTopic && memText.toLowerCase().includes(String(currentTopic).toLowerCase());
      const tagMatch = currentTopic && String(m.tags || []).join(' ').toLowerCase().includes(String(currentTopic).toLowerCase());
      const relevance = simpleRelevanceScore(memText, userMessage) + (topicMatch || tagMatch ? 0.2 : 0);
      const category = m.category || 'other';
      const catWeight = categoryWeights[category] || (category === 'identity' || category === 'preference' ? 1.2 : 1.0);
      const score = (relevance * 0.6 + confidence * 0.3 + importance * 0.1) * catWeight;
      const tokens = estimateTokensForText(memText);
      return { doc: m, score, tokens };
    })
    .filter(Boolean);

  const sorted = _.orderBy(scored, ['score'], ['desc']);
  const selected = [];
  let remaining = tokenBudget;
  for (const s of sorted) {
    if (s.score <= 0.05) break;
    if (s.tokens > remaining) continue;
    selected.push(s.doc);
    remaining -= s.tokens;
    if (remaining <= 0) break;
  }
  return selected;
}

module.exports = { selectRelevantMemories };
