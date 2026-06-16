const { Pinecone } = require('@pinecone-database/pinecone');
const { env } = require('../config/env');

let pineconeClient = null;
let pineconeIndex = null;

function isPineconeConfigured() {
  return Boolean(env.pineconeApiKey && env.pineconeIndexName);
}

async function initPinecone() {
  if (pineconeClient && pineconeIndex) {
    return { client: pineconeClient, index: pineconeIndex };
  }

  if (!isPineconeConfigured()) {
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
  if (!pineconeIndex) {
    const { index } = await initPinecone();
    pineconeIndex = index;
  }
  return pineconeIndex;
}

async function upsertLongTermVector({ id, vector, metadata }) {
  const index = await getIndex();

  await index.upsert([
    {
      id,
      values: vector,
      metadata,
    },
  ]);
}

async function deleteLongTermVector(id) {
  const index = await getIndex();
  await index.deleteOne(id);
}

async function queryLongTermVectors({ vector, topK = 10, filter = {} }) {
  const index = await getIndex();
  
  const results = await index.query({
    vector,
    topK,
    includeMetadata: true,
    includeValues: false,
    filter,
  });

  return results.matches || [];
}

module.exports = {
  initPinecone,
  ensureIndex,
  getIndex,
  upsertLongTermVector,
  deleteLongTermVector,
  queryLongTermVectors,
  isPineconeConfigured,
};
