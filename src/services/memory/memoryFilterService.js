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
  const smallTalk = /\b(?:hi|hello|hey|thanks|thank you|goodbye|bye|yo|nice|cool|ok|okay|sure|great|awesome|lol|haha)\b/;
  const shortMessage = normalized.length < 20 || countWords(normalized) < 3;
  return shortMessage && smallTalk.test(normalized);
}

function isMeaningfulMemory(memory, category) {
  const normalized = normalizeText(memory);
  const wordCount = countWords(normalized);
  if (wordCount < 4) return false;
  if (normalized.length < 30) return false;

  if (category === 'fact' || category === 'event' || category === 'episodic') {
    const informative = /\b(?:year|date|on|at|during|next|last|yesterday|tomorrow|born|graduated|completed|started|joined|left|celebrated)\b/i;
    return informative.test(normalized) && wordCount >= 5;
  }

  return true;
}

function shouldStoreMappedCategory(category) {
  return ALLOWED_CATEGORIES.has(category);
}

function shouldStoreMemoryItem({ category, memory, userMessage }) {
  if (!category || !memory) return false;
  if (!shouldStoreMappedCategory(category)) return false;

  const normalizedMemory = normalizeText(memory);
  const normalizedMessage = normalizeText(userMessage);

  if (isGenericMessage(normalizedMessage)) {
    return false;
  }

  switch (category) {
    case 'identity':
    case 'relationship':
    case 'relationships':
    case 'project':
    case 'projects':
    case 'goal':
    case 'goals':
    case 'preference':
    case 'preferences':
      return isMeaningfulMemory(normalizedMemory, category);
    case 'fact':
    case 'event':
    case 'episodic':
      return isMeaningfulMemory(normalizedMemory, category);
    default:
      return false;
  }
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
  ALLOWED_CATEGORIES,
};
