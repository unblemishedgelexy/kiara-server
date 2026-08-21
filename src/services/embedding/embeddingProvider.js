"use strict";

const { env } = require('../../config/env');
const logger = require('../memory/utils/memoryLogger');
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

  logger && logger.log && logger.log('GOOGLE_PROVIDER_INIT', {
    provider: 'Google',
    sdk: '@google/genai',
    apiKeyLoaded: true,
    ts: new Date().toISOString(),
  });

  const { GoogleGenAI } = require('@google/genai');
  const client = new GoogleGenAI({ apiKey });

  logger && logger.log && logger.log('GOOGLE_PROVIDER_READY', {
    provider: 'Google',
    sdk: '@google/genai',
    model: getEmbeddingModel(),
    ts: new Date().toISOString(),
  });

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
  logger && logger.log && logger.log('GOOGLE_EMBEDDING_START', {
    model: getEmbeddingModel(),
    textLength: cleaned.length,
    ts: new Date().toISOString(),
  });

  try {
    const client = createGoogleClient();
    const model = getEmbeddingModel();
    const response = await client.models.embedContent({ model, contents: [cleaned] });
    const vector = parseEmbeddingResult(response);

    if (!vector) {
      logger && logger.logError && logger.logError('GOOGLE_EMBEDDING_FAIL', 'Google embedding returned invalid vector', {
        response: response ? String(response).slice(0, 200) : null,
      });
      throw new Error('Google embedding returned invalid vector');
    }

    logger && logger.log && logger.log('GOOGLE_EMBEDDING_SUCCESS', {
      model,
      vectorLength: vector.length,
      ts: new Date().toISOString(),
    });
    return vector;
  } catch (err) {
    logger && logger.logError && logger.logError('GOOGLE_EMBEDDING_FAIL', err.message || String(err), {
      stack: err.stack || null,
    });
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
