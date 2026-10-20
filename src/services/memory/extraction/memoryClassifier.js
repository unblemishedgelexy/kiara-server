'use strict';

const { MEMORY_TYPES } = require('../domain/MemoryType');

const TYPE_ALIASES = Object.freeze({
  project: 'project',
  projects: 'project',
  goal: 'goal',
  goals: 'goal',
  preference: 'preference',
  preferences: 'preference',
  pref: 'preference',
  favorite: 'preference',
  favourite: 'preference',
  fact: 'fact',
  facts: 'fact',
  identity: 'identity',
  identities: 'identity',
  relationship: 'relationship',
  relationships: 'relationship',
  habit: 'habit',
  habits: 'habit',
  decision: 'decision',
  decisions: 'decision',
  event: 'event',
  events: 'event',
  episode: 'episode',
  episodes: 'episode',
});

const HEURISTIC_PATTERNS = Object.freeze({
  identity: [
    /\b(i am|i'm|my name is|my name|call me|my nickname is|living in|from|born|work as|study(?:ing)? at)\b/i,
    /\b(?:my|me|i)\s+(?:name|nickname|profession|job|role)\b/i,
    /\b(?:mera|meri|mere|hamara|hamari|aapka|tumhara|tumhari)\s+(?:naam|profession|job|role|city|location)\b/i,
  ],
  preference: [
    /\b(?:prefer|prefers|liked|like|love|enjoy|favorite|favourite|want|wants)\b/i,
    /\b(?:pasand|pasand hai|pasand nahi|favorite|favourite|preference)\b/i,
    /\b(?:dark mode|light mode|python|node|go|typescript|coffee|tea|mac|windows)\b/i,
  ],
  goal: [
    /\b(?:goal|target|objective|plan|want to|wants to|aim to|planning to|intent to|hopes to)\b/i,
    /\b(?:chahata|chahati|chahiye|karna hai|banaana hai|launch|release|build|learn|improve)\b/i,
  ],
  project: [
    /\b(?:building|built|working on|project|app|website|platform|product|initiative|tool|system)\b/i,
    /\b(?:kiara|application|service|dashboard|website|mobile app|platform)\b/i,
    /\b(?:kaam kar raha|kaam kar rahi|bana raha|bana rahi|project)\b/i,
  ],
  fact: [
    /\b(?:use|uses|works with|runs on|based on|is built with|teaches|studies|lives in|lives at|works at)\b/i,
    /\b(?:java|node|python|go|typescript|redis|postgres|mongodb|docker|aws|gcp|sql|react|next|express)\b/i,
    /\b(?:current(?:ly)?|usually|always|never)\b/i,
  ],
  relationship: [
    /\b(?:friend|brother|sister|mother|father|teacher|partner|coworker|colleague|mentor|student|team mate|wife|husband|child|son|daughter)\b/i,
    /\b(?:mera|meri|mere|hamara|hamari|aapka|tumhara|tumhari)\s+(?:friend|brother|sister|mother|father|teacher|partner|coworker|colleague|mentor|student|wife|husband)\b/i,
  ],
  habit: [
    /\b(?:always|usually|often|every day|every week|daily|weekly|habit|routine|schedule)\b/i,
    /\b(?:har roz|har week|regularly|routine|habit)\b/i,
  ],
  decision: [
    /\b(?:decided|decide|choose|chose|opted|prefer|will continue|will stop|committed to)\b/i,
    /\b(?:fix karna|choose|decision|final decision)\b/i,
  ],
  event: [
    /\b(?:tomorrow|next week|next month|today|yesterday|launch|release|meeting|deadline|trip|exam|interview|conference|presentation|birthday)\b/i,
    /\b(?:aaj|kal|agla hafte|next year|next month|launch|release)\b/i,
  ],
  episode: [
    /\b(?:conversation|story|incident|experience|trip|journey|session|discussion|chat|timeline)\b/i,
    /\b(?:experience|incident|story|trip|journey)\b/i,
  ],
});

function normalizeMemoryType(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const alias = TYPE_ALIASES[normalized] || TYPE_ALIASES[normalized.replace(/s$/, '')] || normalized;
  return MEMORY_TYPES.includes(alias) ? alias : null;
}

function classifyMemoryType(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return null;
  }

  if (/\b(?:building|working on|project|app|website|platform|product|tool|system|launch|release)\b/i.test(normalized)) {
    return 'project';
  }

  if (/\b(?:i am|i'm|my name is|call me|my name|born|from|live in|work as|study(?:ing)? at)\b/i.test(normalized)) {
    return 'identity';
  }

  for (const [type, patterns] of Object.entries(HEURISTIC_PATTERNS)) {
    if (patterns.some((pattern) => pattern.test(normalized))) {
      const canonicalType = normalizeMemoryType(type);
      if (canonicalType) {
        return canonicalType;
      }
    }
  }

  return null;
}

function estimateImportance(type) {
  const layout = {
    identity: 'HIGH',
    goal: 'HIGH',
    project: 'HIGH',
    preference: 'MEDIUM',
    relationship: 'HIGH',
    decision: 'HIGH',
    habit: 'MEDIUM',
    event: 'MEDIUM',
    episode: 'MEDIUM',
    fact: 'LOW',
  };

  return layout[type] || 'MEDIUM';
}

function estimateConfidence(type, explicitness = 'medium') {
  const explicitWeight = {
    explicit: 0.9,
    inferred: 0.65,
    medium: 0.72,
  };
  const base = {
    identity: 0.9,
    goal: 0.82,
    project: 0.83,
    preference: 0.8,
    relationship: 0.8,
    decision: 0.78,
    habit: 0.7,
    event: 0.68,
    episode: 0.6,
    fact: 0.64,
  };

  return Math.max(0.1, Math.min(0.98, (base[type] || 0.6) * (explicitWeight[explicitness] || explicitWeight.medium)));
}

module.exports = {
  TYPE_ALIASES,
  normalizeMemoryType,
  classifyMemoryType,
  estimateImportance,
  estimateConfidence,
};
