const LongTermMemory = require('../../models/LongTermMemory');
const SacredMemory = require('../../models/SacredMemory');
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
  // Try decryption first (V6 approach)
  if (typeof doc.encryptedContent === 'string' && doc.encryptedContent.trim()) {
    try {
      return decrypt(doc.encryptedContent);
    } catch (error) {
      // Fall through
    }
  }
  if (typeof doc.encryptedMemory === 'string' && doc.encryptedMemory.trim()) {
    try {
      return decrypt(doc.encryptedMemory);
    } catch (error) {
      console.warn('ContextRouter: failed to decrypt memory text for scoring', error.message || error);
    }
  }
  if (typeof doc.content === 'string' && doc.content.trim()) return doc.content.trim();
  return '';
}

function estimateTokensForText(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

function scoreMemoryForContext(memory, userMessage, currentTopic, categoryWeights) {
  const memText = getMemoryText(memory);
  if (!memText) return null;

  // V6: Rank by relationship, importance, memory strength, confidence
  const isSacred = memory.constructor.modelName === 'SacredMemory';
  const confidence = typeof memory.confidence === 'number' ? memory.confidence : 0.5;
  const importance = (memory.strength?.importanceScore || memory.importanceScore || 0.5);
  const memoryStrength = (memory.strength?.memoryStrength || 0.5);
  const relationshipWeight = (memory.metadata?.relationshipType === 'friend' || memory.metadata?.relationshipType === 'family') ? 1.3 : 1.0;

  const relevance = simpleRelevanceScore(memText, userMessage);
  const topicMatch = currentTopic && memText.toLowerCase().includes(String(currentTopic).toLowerCase());
  const tagMatch = currentTopic && String(memory.tags || []).join(' ').toLowerCase().includes(String(currentTopic).toLowerCase());
  const topicBonus = topicMatch || tagMatch ? 0.2 : 0;

  const category = memory.category || 'other';
  const catWeight = categoryWeights[category] || (category === 'identity' || category === 'relationship' ? 1.4 : 1.0);

  // V6 scoring formula: relationship + importance + strength > relevance
  const score = (
    (relevance * 0.3 +
      confidence * 0.2 +
      importance * 0.25 +
      memoryStrength * 0.25) *
      catWeight *
      relationshipWeight +
    topicBonus
  );

  return {
    doc: memory,
    score: Math.min(1, Math.max(0, score)),
    tokens: estimateTokensForText(memText),
    isSacred,
  };
}

async function selectRelevantMemories({ userId, userMessage = '', currentTopic = '', conversationState = {}, memoryProfile = {}, tokenBudget = 1024, categoryWeights = {}, minConfidence = 0.25 }) {
  // V6: Select from both sacred and LTM, prioritize sacred and high-strength memories
  const [sacred, ltm] = await Promise.all([
    SacredMemory.find({ userId }).lean().limit(100),
    LongTermMemory.find({ userId }).lean().limit(200),
  ]);

  const all = [...sacred, ...ltm];
  const scored = all
    .map((m) => scoreMemoryForContext(m, userMessage, currentTopic, categoryWeights))
    .filter((s) => s && s.score >= minConfidence);

  const sorted = _.orderBy(scored, ['score'], ['desc']);
  const selected = [];
  let remaining = tokenBudget;

  // V6: Return only top 3-5 memories (never inject all memories)
  const maxMemories = 5;
  let count = 0;

  for (const s of sorted) {
    if (count >= maxMemories) break;
    if (s.score <= 0.05) break;
    if (s.tokens > remaining) continue;

    selected.push(s.doc);
    remaining -= s.tokens;
    count++;

    if (remaining <= 0) break;
  }

  return selected;
}

module.exports = { selectRelevantMemories };
