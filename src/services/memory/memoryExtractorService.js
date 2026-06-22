const normalizeText = (text) => String(text || '').trim();

function extractIdentity(text) {
  const out = [];
  const normalized = normalizeText(text);
  const match = normalized.match(/\b(?:my name is|my name's|i am|i'm)\s+(?!\b(?:building|working|developing|creating|starting|launching|planning|project|task|goal|preference|like|love|enjoy)\b)([A-Za-z0-9_\- ]{2,120}?)(?=[\.\,\!\?\n]|$)/i);
  if (match) {
    out.push({ category: 'identity', memory: `User name is ${match[1].trim()}` });
  }
  return out;
}

function extractPreferences(text) {
  const out = [];
  const match = text.match(/\b(?:i (?:like|love|prefer|enjoy)|my favorite|i'm into)\s+([^\.\n]+)/i);
  if (match) {
    out.push({ category: 'preference', memory: `Preference: ${match[1].trim()}` });
  }
  return out;
}

function extractRelationships(text) {
  const out = [];
  const normalized = String(text || '').trim();
  const match = normalized.match(/\b(?:my\s+(?:best\s+)?(?:friend|wife|husband|partner|colleague|boss)|i\s+(?:have|know)\s+(?:a\s+|an\s+)?(?:best\s+)?(?:friend|wife|husband|partner|colleague|boss)|(?:best\s+)?(?:friend|wife|husband|partner|colleague|boss))\s*(?:is|named|called|who\s+is|who's|was|,)?\s*([A-Z][A-Za-z ]{0,78}?)\b/i);
  if (match) {
    const relationshipText = normalized.replace(/\s+/g, ' ').trim();
    out.push({ category: 'relationship', memory: `Relationship: ${relationshipText}` });
  }
  return out;
}

function extractProjects(text) {
  const out = [];
  const match = text.match(/\b(?:building|working on|work on|developing|project is|project called)\s+([^\.\n]+)/i);
  if (match) {
    out.push({ category: 'project', memory: `Project: ${match[1].trim()}` });
  }
  return out;
}

function extractGoals(text) {
  const out = [];
  const match = text.match(/\b(?:i want to|i'd like to|i want|my goal is|i plan to|i have a goal to|i have a goal of)\s+([^\.\n]+)/i);
  if (match) {
    out.push({ category: 'goal', memory: `Goal: ${match[1].trim()}` });
  }
  return out;
}

function extractFacts(text) {
  const out = [];
  const yearMatch = text.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) {
    out.push({ category: 'fact', memory: `Fact: mentioned year ${yearMatch[0]}` });
  }
  return out;
}

function extractEvents(text) {
  const out = [];
  const match = text.match(/\b(?:on|at|during|next|last|yesterday|tomorrow)\s+([^\.\n]+)/i);
  if (match) {
    out.push({ category: 'event', memory: `Event: ${match[1].trim()}` });
  }
  return out;
}

function extractAll(text) {
  const input = normalizeText(text);
  if (!input) return [];
  return [
    ...extractIdentity(input),
    ...extractPreferences(input),
    ...extractRelationships(input),
    ...extractProjects(input),
    ...extractGoals(input),
    ...extractFacts(input),
    ...extractEvents(input),
  ];
}

module.exports = {
  extractIdentity,
  extractPreferences,
  extractRelationships,
  extractProjects,
  extractGoals,
  extractFacts,
  extractEvents,
  extractAll,
};
