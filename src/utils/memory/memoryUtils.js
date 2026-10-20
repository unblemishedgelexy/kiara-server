"use strict";

const crypto = require('crypto');
const { env } = require('../../config/env');
const embeddingProvider = require('../../services/embedding/embeddingProvider');

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function hashId(seed) {
  return crypto.createHash('sha256').update(String(seed || '')).digest('hex').slice(0, 12);
}

async function computeEmbedding(text, options = {}) {
  const cleaned = normalizeText(text);
  return await embeddingProvider.embed(cleaned, options);
}

function getPineconeEmbeddingOptions() {
  const outputDimensionality = Number(env.pineconeVectorDimension);
  return Number.isInteger(outputDimensionality) && outputDimensionality > 0
    ? { outputDimensionality }
    : {};
}

async function validateEmbeddingConfiguration() {
  // Delegate to provider validate where available
  if (embeddingProvider && typeof embeddingProvider.validate === 'function') {
    return await embeddingProvider.validate();
  }
  try {
    const v = await computeEmbedding('Hello Kiara');
    if (!v || !Array.isArray(v) || v.length === 0) throw new Error('invalid vector');
    return { success: true, dimension: v.length };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
}

module.exports = {
  normalizeText,
  computeEmbedding,
  getPineconeEmbeddingOptions,
  hashId,
  validateEmbeddingConfiguration,
};
