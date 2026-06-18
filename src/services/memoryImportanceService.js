function clamp(value, min = 0, max = 1) {
  return Math.min(Math.max(value, min), max);
}

function normalize(value, min, max) {
  if (max === min) return 0.5;
  return clamp((value - min) / (max - min), 0, 1);
}

function scoreRecency(timestamp) {
  if (!timestamp) return 0.2;
  const ageMs = Date.now() - new Date(timestamp).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return clamp(1 - ageDays / 30, 0.2, 1);
}

function scoreFrequency(accessCount) {
  return clamp(Math.log10((accessCount || 0) + 1) / 2, 0.1, 1);
}

function scoreSemanticValue(category) {
  switch (category) {
    case 'identity': return 0.98;
    case 'project': return 0.9;
    case 'goal': return 0.9;
    case 'relationship': return 0.85;
    case 'preference': return 0.75;
    case 'fact': return 0.65;
    case 'event': return 0.7;
    case 'episodic': return 0.85;
    default: return 0.5;
  }
}

function scoreUserRelevance(text, userMessage) {
  if (!userMessage || !text) return 0.2;
  const lowerText = text.toLowerCase();
  const lowerQuery = userMessage.toLowerCase();
  if (lowerText.includes(lowerQuery) || lowerQuery.includes(lowerText)) return 1;
  const queryWords = Array.from(new Set(lowerQuery.split(/\W+/).filter(Boolean)));
  const matches = queryWords.filter((word) => lowerText.includes(word));
  return clamp(matches.length / Math.max(queryWords.length, 1), 0.2, 1);
}

function calculateImportance({ category, lastAccessed, accessCount = 0, memory = '', userMessage = '' }) {
  const recency = scoreRecency(lastAccessed);
  const frequency = scoreFrequency(accessCount);
  const semantic = scoreSemanticValue(category);
  const relevance = scoreUserRelevance(memory, userMessage);
  const score = clamp((recency * 0.25) + (frequency * 0.15) + (semantic * 0.4) + (relevance * 0.2), 0, 1);
  return Number(score.toFixed(4));
}

module.exports = { calculateImportance, scoreRecency, scoreFrequency, scoreSemanticValue, scoreUserRelevance };