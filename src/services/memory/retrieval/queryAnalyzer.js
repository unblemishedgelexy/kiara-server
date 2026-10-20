'use strict';

const { normalizeIntent, isHistoricalQuery, isCurrentQuery, shouldIncludeHistory, isRecentContextQuery } = require('./retrievalPolicy');

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'is', 'are', 'was', 'were', 'what', 'when', 'where', 'why', 'how',
  'who', 'which', 'do', 'does', 'did', 'am', 'i', 'you', 'we', 'they', 'me', 'my', 'your', 'our', 'their', 'to', 'of',
  'in', 'on', 'at', 'for', 'with', 'from', 'about', 'into', 'that', 'this', 'these', 'those', 'it', 'its', 'as', 'be',
  'by', 'as', 'not', 'no', 'yes', 'please', 'remember', 'tell', 'know', 'like', 'just'
]);

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\s\u0900-\u097f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractKeywords(query = '') {
  const normalized = normalizeText(query);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(' ')
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
    .filter((token, index, arr) => arr.indexOf(token) === index)
    .slice(0, 16);
}

function extractEntities(query = '') {
  const normalized = String(query || '').trim();
  if (!normalized) {
    return [];
  }

  const matches = normalized.match(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*\b/g) || [];
  return [...new Set(matches.map((value) => value.trim()))];
}

function inferIntent(query = '') {
  const text = String(query || '').toLowerCase();
  const hasHistoricalReference = /(?:use|used)\s+to|previously|before|formerly|history|old|used to live|where did i live|remember when|when did i/.test(text);

  if (/\b(my name|myself|who am i|what is my name|mera naam|kaun hu main)\b/.test(text)) {
    return 'IDENTITY';
  }
  if (/\b(prefer|preference|preferences|favorite|favourite|pasand|like|love|choose|theme|color)\b/.test(text)) {
    return 'PREFERENCE';
  }
  if (/\b(project|building|working on|developing|app|website|feature|kiara)\b/.test(text)) {
    return 'PROJECT';
  }
  if (/\b(goal|objective|aim|plan|want to|need to|target|dream)\b/.test(text)) {
    return 'GOAL';
  }
  if (/\b(framework|tool|language|editor|library|database|styling|style|technology|platform)\b/.test(text)
    && /\b(prefer|favorite|favourite|like|use|used|before|previously)\b/.test(text)) {
    return 'PREFERENCE';
  }
  if (/\b(friend|family|relationship|brother|sister|mother|father|met|person)\b/.test(text)) {
    return 'RELATIONSHIP';
  }
  if (hasHistoricalReference && /\b(live|city|country|reside|home|where do i live|where do i stay)\b/.test(text)) {
    return 'EPISODE';
  }
  if (/\b(live|city|country|reside|home|where do i live|where do i stay)\b/.test(text)) {
    return 'FACT';
  }
  if (isRecentContextQuery(text)) {
    return 'RECENT_CONTEXT';
  }
  if (shouldIncludeHistory(text) || hasHistoricalReference) {
    return 'EPISODE';
  }
  if (/\b(remember|recall|what happened|when did|used to|before|history)\b/.test(text)) {
    return 'EPISODE';
  }
  if (/\b(what are you|do you remember|what did i say|what did we discuss)\b/.test(text)) {
    return 'RECENT_CONTEXT';
  }

  return 'GENERAL_MEMORY';
}

function inferTemporalHints(query = '') {
  const text = String(query || '').toLowerCase();
  const hints = [];

  if (/\b(today|aaj|now|right now|currently)\b/.test(text)) hints.push('current');
  if (/\b(yesterday|kal|last night)\b/.test(text)) hints.push('recent');
  if (/\b(used to|before|formerly|previously|old)\b/.test(text)) hints.push('historical');
  if (/\b(next year|later|future|will move|soon)\b/.test(text)) hints.push('future');

  return hints;
}

function analyzeQuery(query = '') {
  const text = String(query || '').trim();
  const intent = normalizeIntent(inferIntent(text));
  const keywords = extractKeywords(text);
  const entities = extractEntities(text);
  const temporalHints = inferTemporalHints(text);
  const includeHistory = shouldIncludeHistory(text) || isHistoricalQuery(text) || isCurrentQuery(text);

  return {
    rawQuery: text,
    intent,
    keywords,
    entities,
    temporalHints,
    includeHistory,
    needsRecentContext: isRecentContextQuery(text),
  };
}

module.exports = {
  analyzeQuery,
  inferIntent,
  extractKeywords,
  extractEntities,
  inferTemporalHints,
};
