const { Pinecone } = require('@pinecone-database/pinecone');
const { env } = require('../config/env');

let pineconeClient = null;
let pineconeIndex = null;
let pineconeUnavailable = false;

function isPineconeConfigured() {
  return Boolean(env.pineconeApiKey && env.pineconeIndexName);
}

async function initPinecone() {
  if (pineconeClient && pineconeIndex) {
    return { client: pineconeClient, index: pineconeIndex };
  }

  if (!isPineconeConfigured()) {
    pineconeUnavailable = true;
    throw new Error('Pinecone is not configured. Set PINECONE_API_KEY and PINECONE_INDEX_NAME.');
  }

  pineconeClient = new Pinecone({
    apiKey: env.pineconeApiKey,
  });

  pineconeIndex = pineconeClient.Index(env.pineconeIndexName);
  return { client: pineconeClient, index: pineconeIndex };
}

async function ensureIndex() {
  if (!isPineconeConfigured()) {
    return null;
  }

  try {
    const client = new Pinecone({
      apiKey: env.pineconeApiKey,
    });

    const indexes = await client.listIndexes();
    const indexExists = indexes.some(idx => idx.name === env.pineconeIndexName);
    
    if (!indexExists) {
      await client.createIndex({
        name: env.pineconeIndexName,
        dimension: env.pineconeVectorDimension,
        metric: 'cosine',
        spec: {
          serverless: {
            cloud: 'aws',
            region: 'us-east-1',
          },
        },
      });
    }
  } catch (error) {
    console.warn('Unable to ensure Pinecone index exists:', error);
  }
}

async function getIndex() {
  if (pineconeUnavailable) return null;
  if (!pineconeIndex) {
    try {
      const { index } = await initPinecone();
      pineconeIndex = index;
    } catch (err) {
      pineconeUnavailable = true;
      console.warn('[PINECONE_SKIPPED] initialization failed:', err && err.message ? err.message : err);
      return null;
    }
  }
  return pineconeIndex;
}

async function upsertLongTermVector({ id, vector, metadata }) {
  try {
    const index = await getIndex();
    if (!index) {
      console.warn('[PINECONE_SKIPPED] upsert skipped: index unavailable');
      return;
    }

    await index.upsert([
      {
        id,
        values: vector,
        metadata,
      },
    ]);
  } catch (err) {
    pineconeUnavailable = true;
    console.warn('[PINECONE_SKIPPED] upsert failed:', err && err.message ? err.message : err);
  }
}

async function deleteLongTermVector(id) {
  try {
    const index = await getIndex();
    if (!index) {
      console.warn('[PINECONE_SKIPPED] delete skipped: index unavailable');
      return;
    }
    await index.deleteOne(id);
  } catch (err) {
    pineconeUnavailable = true;
    console.warn('[PINECONE_SKIPPED] delete failed:', err && err.message ? err.message : err);
  }
}

async function queryLongTermVectors({ vector, topK = 10, filter = {} }) {
  try {
    const index = await getIndex();
    if (!index) {
      console.warn('[PINECONE_SKIPPED] query skipped: index unavailable');
      return [];
    }

    const results = await index.query({
      vector,
      topK,
      includeMetadata: true,
      includeValues: false,
      filter,
    });

    return results.matches || [];
  } catch (err) {
    pineconeUnavailable = true;
    console.warn('[PINECONE_SKIPPED] query failed:', err && err.message ? err.message : err);
    return [];
  }
}

module.exports = {
  initPinecone,
  ensureIndex,
  getIndex,
  upsertLongTermVector,
  deleteLongTermVector,
  queryLongTermVectors,
  isPineconeConfigured,
  // exposed for diagnostics
  _pineconeUnavailable: () => pineconeUnavailable,
};
