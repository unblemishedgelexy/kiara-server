'use strict';

const { computeEmbedding, getPineconeEmbeddingOptions } = require('../../../utils/memory/memoryUtils');
const { toSemanticText } = require('./semanticIndexMapper');

async function embedText(text) {
  const startedAt = Date.now();
  const vector = await computeEmbedding(text, getPineconeEmbeddingOptions());
  if (!Array.isArray(vector) || vector.length === 0 || vector.some((value) => !Number.isFinite(Number(value)))) {
    throw new Error('Embedding provider returned an invalid vector.');
  }
  return {
    embedding: vector.map(Number),
    latencyMs: Date.now() - startedAt,
  };
}

async function embedMemory(memory) {
  const text = toSemanticText(memory);
  return {
    ...await embedText(text),
    text,
  };
}

async function embedQuery(query) {
  const text = String(query || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    throw new TypeError('Query text is required for embedding.');
  }
  return embedText(text);
}

module.exports = {
  embedMemory,
  embedQuery,
};
