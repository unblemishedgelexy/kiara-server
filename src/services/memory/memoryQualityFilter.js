/**
 * Memory Quality Filter (V7)
 * Filters low-value chat before saving to LTM.
 * Only meaningful information is persisted.
 */

// Low-value patterns to ignore
const LOW_VALUE_PATTERNS = {
  acknowledgements: [
    /^(ok|okay|yes|no|yep|nope|sure|thanks|thank you|thanks a lot|cool|nice|good|great|awesome|hmm|huh|uh-huh|uh|ah|hey|hello|hi|hey there|what's up|sup)$/i,
    /^(got it|i see|i understand|understood|yeah|yup|mm-hmm|mm-hm|uh-huh|sounds good|alright|fine|whatever)$/i,
    /^(lol|lmao|haha|hehe|rofl|roflmao|lulz|xd|xD)$/i,
  ],
  filler: [
    /^(um|uh|er|like|you know|i mean|basically|actually|literally|seriously|honestly|frankly|honestly speaking|to be honest)$/i,
  ],
  social: [
    /^(goodbye|bye|see you|see you later|later|catch you|take care|cya|farewell|adios|hasta la vista)$/i,
    /^(good morning|good afternoon|good evening|good night|morning|afternoon|evening)$/i,
  ],
  questions: [
    /^(what\?|huh\?|\?|what|eh|come again|repeat)$/i,
  ],
};

const MINIMUM_LENGTH = 10; // Minimum characters
const MINIMUM_WORDS = 2;   // Minimum word count
const MINIMUM_MEANINGFUL_CHARS = 6; // After filtering punctuation

function isLowValue(text) {
  if (!text || typeof text !== 'string') return true;

  const trimmed = text.trim();

  // Check length
  if (trimmed.length < MINIMUM_LENGTH) {
    return true;
  }

  // Check word count
  const words = trimmed.split(/\s+/);
  if (words.length < MINIMUM_WORDS) {
    return true;
  }

  // Check for acknowledgements
  for (const pattern of LOW_VALUE_PATTERNS.acknowledgements) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  // Check for filler words
  for (const pattern of LOW_VALUE_PATTERNS.filler) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  // Check for social phrases
  for (const pattern of LOW_VALUE_PATTERNS.social) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  // Check for isolated questions
  for (const pattern of LOW_VALUE_PATTERNS.questions) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  // Check for meaningful content (not just punctuation)
  const meaningful = trimmed.replace(/[^\w\s]/g, '');
  if (meaningful.length < MINIMUM_MEANINGFUL_CHARS) {
    return true;
  }

  return false;
}

function filterContent(text) {
  if (isLowValue(text)) {
    return null;
  }

  // Clean up the text
  let cleaned = text.trim();

  // Remove excessive punctuation
  cleaned = cleaned.replace(/([.!?]){2,}/g, '$1');

  // Remove leading/trailing punctuation
  cleaned = cleaned.replace(/^[^\w]+|[^\w]+$/g, '');

  return cleaned.length >= MINIMUM_LENGTH ? cleaned : null;
}

function evaluateMemoryQuality(memory) {
  if (!memory) return { quality: 'invalid', score: 0, shouldSave: false };

  const text = memory.text || memory.content || memory.encryptedMemory || '';
  
  if (isLowValue(text)) {
    return {
      quality: 'low_value',
      score: 0,
      shouldSave: false,
      reason: 'Content matches low-value pattern',
    };
  }

  // Score based on content characteristics
  let score = 0.5; // Base score

  const length = text.length;
  const words = text.split(/\s+/).length;

  // Add points for length
  if (length > 50) score += 0.2;
  if (length > 200) score += 0.1;

  // Add points for word count
  if (words > 5) score += 0.1;
  if (words > 20) score += 0.1;

  // Add points for specific indicators of importance
  if (/name|goal|project|important|remember|note/i.test(text)) score += 0.2;
  if (/person|people|family|friend|colleague|mentor/i.test(text)) score += 0.2;
  if (/[0-9]+/.test(text)) score += 0.05; // Numbers often indicate facts

  // Cap score at 1.0
  score = Math.min(score, 1.0);

  return {
    quality: score >= 0.6 ? 'high_value' : 'medium_value',
    score: Math.round(score * 100) / 100,
    shouldSave: score >= 0.3, // Save if quality >= 30%
  };
}

function batchFilterContent(messages) {
  const filtered = [];

  for (const msg of messages) {
    const cleaned = filterContent(msg);
    if (cleaned) {
      filtered.push(cleaned);
    }
  }

  return filtered;
}

module.exports = {
  isLowValue,
  filterContent,
  evaluateMemoryQuality,
  batchFilterContent,
  MINIMUM_LENGTH,
  MINIMUM_WORDS,
  LOW_VALUE_PATTERNS,
};
