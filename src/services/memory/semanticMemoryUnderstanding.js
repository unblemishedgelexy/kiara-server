'use strict';

const { generateText } = require('../live/geminiService');
const { log: traceLog } = require('./utils/memoryTrace');

const SUPPORTED_CATEGORIES = new Set(['identity', 'preference', 'goal', 'fact', 'skill', 'project', 'relationship']);
const inFlightUnderstanding = new Map();

function shouldUseSemanticUnderstanding(text, deterministicGroup) {
  const value = String(text || '').trim();
  if (!value || value.length < 3) return false;
  if (/^(?:https?:\/\/|\/api\/|\{.*\}$)/is.test(value)) return false;
  if (/[?؟]$/.test(value) || /\b(?:might|maybe|perhaps|think|unsure|not sure)\b/i.test(value)) return true;
  const deterministicValues = Object.values(deterministicGroup || {}).flat().map((item) => String(item?.value || '').trim().toLowerCase());
  if (deterministicValues.some((item) => ['name', 'goal', 'preference', 'identity'].includes(item))) return true;
  return !deterministicGroup || Object.keys(deterministicGroup).length === 0;
}

function parseJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

function normalizeResult(result, sourceTurnId, sourceRole = 'user') {
  if (sourceRole !== 'user') return {};
  const memories = Array.isArray(result?.memories) ? result.memories : [];
  const grouped = {};
  for (const item of memories) {
    const category = String(item.category || item.type || item.intent || '')
      .toLowerCase()
      .replace(/_(?:assertion|correction)$/, '')
      .replace(/s$/, '');
    const attribute = String(item.attribute || item.key || item.logicalKey || '').split(':').pop().trim();
    const value = String(item.value || item.newValue || item.content || '').trim();
    if (!SUPPORTED_CATEGORIES.has(category) || !attribute || !value) continue;
    if (item.intent === 'question' || item.intent === 'uncertainty' || item.userAssertion === false || item.memoryWorthy === false) continue;
    const confidenceValue = Number(item.confidence);
    const confidence = Math.max(0, Math.min(1, Number.isFinite(confidenceValue) ? confidenceValue : 0.8));
    if (confidence < 0.55 || item.uncertainty === true) continue;
    const key = category === 'identity' ? 'name' : attribute.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
    const fact = {
      id: `semantic:${category}:${key}:${value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 64)}`,
      category,
      key,
      attribute: key,
      label: category === 'identity' ? 'Name' : category,
      value,
      source: 'user',
      userOwned: true,
      memoryWorthy: true,
      status: 'active',
      confidenceScore: confidence,
      importance: Math.min(1, confidence * 0.9 + 0.1),
      reason: 'Semantic user assertion classified by the memory understanding layer.',
      source_turn_ids: sourceTurnId ? [sourceTurnId] : [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    grouped[category] = grouped[category] || [];
    grouped[category].push(fact);
  }
  return grouped;
}

async function understandUserMemory(text, { userId = null, memoryTraceId = null, sourceTurnId = null } = {}) {
  const requestKey = `${userId || 'anonymous'}:${String(text || '').trim()}`;
  const existingRequest = inFlightUnderstanding.get(requestKey);
  if (existingRequest) return existingRequest;

  const request = understandUserMemoryInternal(text, { userId, memoryTraceId, sourceTurnId });
  inFlightUnderstanding.set(requestKey, request);
  try {
    return await request;
  } finally {
    inFlightUnderstanding.delete(requestKey);
  }
}

async function understandUserMemoryInternal(text, { userId = null, memoryTraceId = null, sourceTurnId = null } = {}) {
  const prompt = `Classify the meaning of this user utterance for a persistent memory system. Understand any language or code-switching; do not use word matching. Return JSON only: {"memories":[]} or {"memories":[...]}.
Each memory must contain category (identity, preference, goal, fact, skill, project, relationship), attribute, value, intent, memoryWorthy, userAssertion, correction, uncertainty, confidence.
Only emit a memory for a clear user-originated factual assertion or correction. Questions, requests, greetings, filler, hypotheses, jokes, uncertainty, and conversational references must emit no memory. Assistant text is never input to this function.
Utterance: ${String(text).slice(0, 1200)}`;

  try {
    const response = await generateText({ prompt, userId, memoryTraceId, maxOutputTokens: 700, temperature: 0, candidateCount: 1, maxAttempts: 1 });
    const parsed = parseJson(response.text);
    const normalized = normalizeResult(parsed, sourceTurnId, 'user');
    traceLog('semantic_understanding_result', { memoryTraceId, userId, operation: 'user_memory_understanding', memoryCount: Object.values(normalized).flat().length, categories: Object.keys(normalized), status: 'completed' });
    return normalized;
  } catch (error) {
    traceLog('semantic_understanding_result', { memoryTraceId, userId, operation: 'user_memory_understanding', memoryCount: 0, status: 'unavailable', reason: error.message || String(error) });
    return null;
  }
}

module.exports = { shouldUseSemanticUnderstanding, understandUserMemory };
