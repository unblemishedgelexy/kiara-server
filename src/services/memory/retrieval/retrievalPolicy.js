'use strict';

const MEMORY_INTENTS = Object.freeze([
  'IDENTITY',
  'PREFERENCE',
  'GOAL',
  'PROJECT',
  'FACT',
  'RELATIONSHIP',
  'HABIT',
  'DECISION',
  'EVENT',
  'EPISODE',
  'RECENT_CONTEXT',
  'GENERAL_MEMORY',
]);

const INTENT_TO_MEMORY_TYPES = Object.freeze({
  IDENTITY: ['identity', 'fact'],
  PREFERENCE: ['preference'],
  GOAL: ['goal'],
  PROJECT: ['project'],
  FACT: ['fact', 'identity'],
  RELATIONSHIP: ['relationship', 'fact'],
  HABIT: ['habit'],
  DECISION: ['decision'],
  EVENT: ['event', 'fact'],
  EPISODE: ['episode', 'event'],
  RECENT_CONTEXT: ['episode', 'event', 'fact'],
  GENERAL_MEMORY: ['fact', 'preference', 'project', 'goal', 'identity', 'relationship', 'event', 'episode'],
});

function normalizeIntent(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return MEMORY_INTENTS.includes(normalized) ? normalized : 'GENERAL_MEMORY';
}

function isHistoricalQuery(query = '') {
  const text = String(query || '').toLowerCase();
  return /used to|previously|before|history|remember when|where did i live|before this|old/.test(text);
}

function isCurrentQuery(query = '') {
  const text = String(query || '').toLowerCase();
  return /current|now|today|right now|present|what is my/.test(text);
}

function shouldIncludeHistory(query = '') {
  return isHistoricalQuery(query) || /used to|previously|before|old|earlier|where did i live|when did i/.test(String(query || '').toLowerCase());
}

function isRecentContextQuery(query = '') {
  const text = String(query || '').toLowerCase();
  return /what were we discussing|what did we talk about|what are we doing|recent|context|where did we leave off|what happened/.test(text);
}

module.exports = {
  MEMORY_INTENTS,
  INTENT_TO_MEMORY_TYPES,
  normalizeIntent,
  isHistoricalQuery,
  isCurrentQuery,
  shouldIncludeHistory,
  isRecentContextQuery,
};
