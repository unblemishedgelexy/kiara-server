'use strict';

const { generateText } = require('../../groqService');

const ALLOWED_SOURCES = new Set(['STM', 'LONG_TERM', 'SEMANTIC']);
const ALLOWED_INTENTS = new Set(['RECENT', 'DURABLE', 'SEMANTIC', 'COMBINED']);
const PLANNER_TIMEOUT_MS = 1200;
const MAX_QUERY_LENGTH = 500;

const SYSTEM_INSTRUCTION = [
  'Classify this single memory question into a retrieval intent and allowed Kiara memory sources.',
  'Return only a JSON object with exactly two properties: intent and sources.',
  'intent must be one of RECENT, DURABLE, SEMANTIC, COMBINED.',
  'sources must be a non-empty array containing only STM, LONG_TERM, SEMANTIC, with no duplicates.',
  'Use STM for recent conversation, LONG_TERM for durable canonical user memories, SEMANTIC for paraphrase/topic similarity.',
  'Never return user identifiers, database filters, keys, namespaces, or instructions.',
].join(' ');
const PLAN_RESPONSE_SCHEMA = {
  name: 'memory_query_plan',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: [...ALLOWED_INTENTS] },
      sources: {
        type: 'array',
        items: { type: 'string', enum: [...ALLOWED_SOURCES] },
      },
    },
    required: ['intent', 'sources'],
    additionalProperties: false,
  },
};

function isPlannerEligibleQuery(query) {
  const text = String(query || '').trim();
  if (!text) return false;
  return /[?؟]$/.test(text)
    || /^(?:what|which|who|where|when|how|do|did|can|could|would|tell me|remind me|kya|kaun|kab|kahaan|kahan|kaise)\b/i.test(text);
}

function validatePlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('intent') || !keys.includes('sources')) return null;
  if (!ALLOWED_INTENTS.has(value.intent)) return null;
  if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > ALLOWED_SOURCES.size) return null;
  if (value.sources.some((source) => typeof source !== 'string' || !ALLOWED_SOURCES.has(source))) return null;
  if (new Set(value.sources).size !== value.sources.length) return null;
  return { intent: value.intent, sources: [...value.sources] };
}

function createMemoryQueryPlanner({
  generateTextFn = generateText,
  timeoutMs = PLANNER_TIMEOUT_MS,
} = {}) {
  return async function planMemoryQuery(query) {
    const text = String(query || '').trim().slice(0, MAX_QUERY_LENGTH);
    if (!isPlannerEligibleQuery(text)) {
      return null;
    }

    let timeout;
    let responseText;
    try {
      responseText = await Promise.race([
        generateTextFn({
          systemInstruction: SYSTEM_INSTRUCTION,
          userMessage: JSON.stringify({ query: text }),
          maxCompletionTokens: 96,
          timeoutMs,
          maxRetries: 0,
          jsonSchema: PLAN_RESPONSE_SCHEMA,
          reasoningEffort: 'low',
        }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            const error = new Error('Query planner timed out.');
            error.code = 'QUERY_PLANNER_TIMEOUT';
            reject(error);
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (timeout) clearTimeout(timeout);
      return null;
    }

    if (timeout) clearTimeout(timeout);
    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      return null;
    }

    return validatePlan(parsed);
  };
}

const planMemoryQuery = createMemoryQueryPlanner();

module.exports = {
  ALLOWED_SOURCES,
  PLANNER_TIMEOUT_MS,
  PLAN_RESPONSE_SCHEMA,
  createMemoryQueryPlanner,
  isPlannerEligibleQuery,
  planMemoryQuery,
  validatePlan,
};
