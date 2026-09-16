"use strict";

const { env } = require('../../config/env');
const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-2';

function getApiKey() {
  return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || env.googleApiKey;
}

function getEmbeddingModel() {
  return process.env.GEMINI_EMBEDDING_MODEL || env.geminiEmbeddingModel || DEFAULT_EMBEDDING_MODEL;
}

function createGoogleClient() {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('Google API key is not configured. Set GEMINI_API_KEY or GOOGLE_API_KEY.');
  }

  const { GoogleGenAI } = require('@google/genai');
  const client = new GoogleGenAI({ apiKey });

  return client;
}

function parseEmbeddingResult(response) {
  if (!response) return null;
  const firstEmbedding = response?.embeddings?.[0];
  const vector = Array.isArray(firstEmbedding?.values)
    ? firstEmbedding.values
    : Array.isArray(firstEmbedding)
    ? firstEmbedding
    : response?.data?.[0]?.embedding || response?.embedding || response?.output?.[0]?.embedding || null;
  return Array.isArray(vector) && vector.length > 0 ? vector : null;
}

async function embed(text) {
  const cleaned = String(text || '').trim();
  try {
    const client = createGoogleClient();
    const model = getEmbeddingModel();
    const response = await client.models.embedContent({ model, contents: [cleaned] });
    const vector = parseEmbeddingResult(response);

    if (!vector) {
      throw new Error('Google embedding returned invalid vector');
    }

    return vector;
  } catch (err) {
    throw err;
  }
}

function getProviderInfo() {
  return {
    provider: 'Google',
    sdk: '@google/genai',
    apiKeyLoaded: Boolean(getApiKey()),
    model: getEmbeddingModel(),
  };
}

async function validate() {
  try {
    const vector = await embed('Hello Kiara');
    if (!vector || !Array.isArray(vector) || vector.length === 0) {
      return { success: false, error: 'invalid vector' };
    }
    return { success: true, dimension: vector.length };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
}

module.exports = {
  embed,
  validate,
  getProviderInfo,
};
