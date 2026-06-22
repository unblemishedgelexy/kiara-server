const ALLOWED_CATEGORIES = new Set([
  'identity',
  'preference',
  'preferences',
  'relationship',
  'relationships',
  'project',
  'projects',
  'goal',
  'goals',
  'fact',
  'event',
  'episodic',
]);

function normalizeText(text) {
  return String(text || '').trim();
}

function countWords(text) {
  return normalizeText(text).split(/\s+/).filter(Boolean).length;
}

function isGenericMessage(text) {
  if (!text) return true;
  const normalized = normalizeText(text).toLowerCase();
  const explicitMemoryIntent = /\b(?:my name is|my name's|i am|i'm|i like|i love|i prefer|my favorite|i'm into|my best friend is|my goal is|i want to|i'm building|i am building|i'm working on|i am working on|my project is|project called)\b/i;
  if (explicitMemoryIntent.test(text)) {
    return false;
  }

  const smallTalk = /\b(?:hi|hello|hey|thanks|thank you|goodbye|bye|yo|nice|cool|ok|okay|sure|great|awesome|lol|haha)\b/;
  const shortMessage = normalized.length < 20 || countWords(normalized) < 3;
  return shortMessage && smallTalk.test(normalized);
}

function isShortLabeledMemory(normalized, category) {
  const labelPatterns = {
    identity: /^user name is\s+/i,
    preference: /^preference:\s*/i,
    project: /^project:\s*/i,
    relationship: /^relationship:\s*/i,
    goal: /^goal:\s*/i,
  };
  const pattern = labelPatterns[category];
  if (!pattern) return false;
  const withoutLabel = normalized.replace(pattern, '').trim();
  return withoutLabel.length >= 4 && countWords(withoutLabel) >= 1;
}

function isMeaningfulMemory(memory, category) {
  const normalized = normalizeText(memory);
  const wordCount = countWords(normalized);

  if (category === 'fact' || category === 'event' || category === 'episodic') {
    if (wordCount < 5) return false;
    if (normalized.length < 30) return false;
    const informative = /\b(?:year|date|on|at|during|next|last|yesterday|tomorrow|born|graduated|completed|started|joined|left|celebrated)\b/i;
    return informative.test(normalized);
  }

  if (['identity', 'relationship', 'project', 'goal', 'preference', 'preferences'].includes(category)) {
    if (isShortLabeledMemory(normalized, category)) return true;
    if (wordCount < 2) return false;
    return normalized.length >= 10;
  }

  return false;
}

function shouldStoreMappedCategory(category) {
  return ALLOWED_CATEGORIES.has(category);
}

function getMemoryFilterReason({ category, memory, userMessage }) {
  if (!category || !memory) return 'missing_category_or_memory';
  if (!shouldStoreMappedCategory(category)) return 'unsupported_category';

  const normalizedMemory = normalizeText(memory);
  const normalizedMessage = normalizeText(userMessage);

  if (isGenericMessage(normalizedMessage)) {
    return 'generic_user_message';
  }

  const isMeaningful = isMeaningfulMemory(normalizedMemory, category);
  if (isMeaningful) {
    return 'accepted';
  }

  return 'not_meaningful';
}

function shouldStoreMemoryItem({ category, memory, userMessage }) {
  return getMemoryFilterReason({ category, memory, userMessage }) === 'accepted';
}

function auditExtractedMemories(extracted = [], userMessage = '') {
  if (!Array.isArray(extracted) || extracted.length === 0) {
    return { accepted: [], rejected: [] };
  }

  const accepted = [];
  const rejected = [];

  for (const item of extracted) {
    const reason = getMemoryFilterReason({
      category: item.category,
      memory: item.memory,
      userMessage,
    });

    if (reason === 'accepted') {
      accepted.push(item);
    } else {
      rejected.push({ item, reason });
    }
  }

  return { accepted, rejected };
}

function filterExtractedMemories(extracted = [], userMessage = '') {
  if (!Array.isArray(extracted) || extracted.length === 0) return [];
  return extracted.filter((item) => shouldStoreMemoryItem({
    category: item.category,
    memory: item.memory,
    userMessage,
  }));
}

module.exports = {
  shouldStoreMemoryItem,
  filterExtractedMemories,
  auditExtractedMemories,
  getMemoryFilterReason,
  ALLOWED_CATEGORIES,
};
