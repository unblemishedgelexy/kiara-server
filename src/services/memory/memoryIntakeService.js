const sacredMemoryService = require('./sacredMemoryService');
const personProfileService = require('./personProfileService');
const activeContextService = require('./activeContextService');
const followUpMemoryService = require('./followUpMemoryService');
const memoryStrengthService = require('./memoryStrengthService');
const { ensureUserId } = require('../../utils/ensureUserId');

// Simple NLP for extracting person names and intent
function extractPersonName(text) {
  const patterns = [
    /\b(?:my|our|her|his|their|his|your)\s+(?:best\s+)?(?:friend|brother|sister|father|mother|dad|mom|wife|husband|boss|colleague)\s*(?:is|named|called|who\s+is|who's|was)?\s*([A-Z][a-z]+(?: [A-Z][a-z]+)*)/i,
    /\b(?:my|our|her|his|their|your)\s+(?:best\s+)?(?:friend|brother|sister|father|mother|dad|mom|wife|husband|boss|colleague)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)*)/i,
    /\b(?:i|we|he|she|they)\s+(?:know|met|talked to|spoke with)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)*)/i,
    /\b(?:friend|brother|sister|father|mother|dad|mom|wife|husband|boss|colleague)\s+(?:is|named|called|who\s+is|who's|was)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)*)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }

  const words = text.split(/\s+/);
  const capitals = words.filter((w) => /^[A-Z][a-z]+(?: [A-Z][a-z]+)*$/.test(w));
  return capitals[capitals.length - 1] || null;
}

function categorizeMemory(text, context = {}) {
  const lower = String(text).toLowerCase();

  // Sacred category detection - prefer specific patterns to avoid misclassification
  // Project/goal/relationship detection first to avoid catching "I'm building" as identity
  if (lower.includes('project') || lower.includes('working on') || lower.includes('building')) return 'project';
  if (lower.includes('want to') || lower.includes("i'd like to") || lower.includes('dream') || lower.includes('goal') || lower.includes('plan')) return 'goal';
  if (lower.includes('mother') || lower.includes('father') || lower.includes('sister') || lower.includes('brother')) return 'family';
  if (lower.includes('friend') || lower.includes('colleague') || lower.includes('boss')) return 'relationship';

  // Identity detection: require explicit name-like patterns to avoid generic "I'm" matches
  if (/\bmy name is\b|\bmy name's\b|\bcall me\b/i.test(text)) return 'identity';
  if (/\b(?:i am|i'm|im)\s+[A-Z][a-z0-9_\- ]{1,60}\b/.test(text)) return 'identity';

  return 'life_fact';
}

function detectFollowUp(text) {
  const followUpKeywords = ['update me', 'let me know', 'tell me later', 'remind me', 'follow up', 'check in', 'how did', 'how is'];
  const lower = String(text).toLowerCase();

  for (const keyword of followUpKeywords) {
    if (lower.includes(keyword)) {
      return {
        hasFollowUp: true,
        keyword,
      };
    }
  }

  return { hasFollowUp: false };
}

async function processIncomingMemory(userId, sessionId, message, context = {}) {
  ensureUserId(userId);
  if (!message || typeof message !== 'string') {
    return { success: false, error: 'Message is required' };
  }

  try {
    const results = {
      processed: false,
      memories: [],
      followUps: [],
      people: [],
    };

    // Extract person name
    const personName = extractPersonName(message);
    if (personName) {
      await personProfileService.recordPersonMention(userId, personName);
      await personProfileService.upsertPersonProfile(userId, personName);
      results.people.push(personName);
    }

    // Categorize memory
    const category = categorizeMemory(message, context);

    // Only save sacred memories automatically (not all LTM)
    const sacredCategories = ['identity', 'family', 'relationship', 'goal', 'project'];

    if (sacredCategories.includes(category)) {
      const metadata = personName ? { personName } : {};
      const sacred = await sacredMemoryService.saveSacredMemory({
        userId,
        category,
        content: message,
        metadata,
        tags: [category, sessionId],
      });

      results.memories.push({
        type: 'sacred',
        category,
        id: sacred._id,
      });

      results.processed = true;
    }

    // Detect follow-ups
    const followUpCheck = detectFollowUp(message);
    if (followUpCheck.hasFollowUp) {
      const followUp = await followUpMemoryService.createFollowUp(userId, message.substring(0, 100), {
        relatedPeople: personName ? [personName] : [],
        description: message,
        priority: 'medium',
      });

      results.followUps.push({
        id: followUp._id,
        topic: followUp.topic,
        priority: followUp.priority,
      });
    }

    // Update active context with current topic
    if (context.sessionId) {
      await activeContextService.updateContext(userId, context.sessionId, {
        currentTopic: category === 'identity' ? 'Personal info' : category,
        lastQuestion: message,
      });
    }

    return {
      success: true,
      ...results,
    };
  } catch (err) {
    console.error('Error processing incoming memory:', err);
    return {
      success: false,
      error: err.message,
    };
  }
}

async function enrichMemoryWithStrength(userId, memoryId, source = 'sacred') {
  ensureUserId(userId);

  // Record access
  await memoryStrengthService.recordMemoryAccess(userId, memoryId, source);

  // Optionally boost importance based on mentions
  // This would be called periodically in background jobs
}

module.exports = {
  processIncomingMemory,
  enrichMemoryWithStrength,
  extractPersonName,
  categorizeMemory,
  detectFollowUp,
};
