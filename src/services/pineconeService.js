let PineconePkg = null;
try {
  PineconePkg = require('@pinecone-database/pinecone');
} catch (e) {
  PineconePkg = null;
}
const { env } = require('../config/env');

let pineconeClient = null;
let pineconeIndex = null;
let pineconeUnavailable = false;

function isPineconeConfigured() {
  return Boolean(env.pineconeApiKey && env.pineconeIndexName);
}

function buildPineconeClientOptions() {
  const opts = { apiKey: env.pineconeApiKey };
  // optional override for controller host
  if (env.pineconeHost) opts.controllerHostUrl = env.pineconeHost;
  return opts;
}

async function validateConfiguration() {
  const errors = [];
  if (!env.pineconeApiKey) errors.push('PINECONE_API_KEY missing');
  if (!env.pineconeIndexName) errors.push('PINECONE_INDEX_NAME missing');
  if (!PineconePkg) errors.push('@pinecone-database/pinecone package not installed');
  if (errors.length) return { success: false, errors };

  try {
    const clientOpts = buildPineconeClientOptions();
    const client = new PineconePkg.Pinecone(clientOpts);
    const idxList = await client.listIndexes();
    const indexes = Array.isArray(idxList)
      ? idxList
      : (Array.isArray(idxList?.indexes) ? idxList.indexes : []);
    return { success: true, indexes };
  } catch (err) {
    return { success: false, errors: [err.message || String(err)] };
  }
}

async function initPinecone() {
  if (pineconeClient && pineconeIndex) return { client: pineconeClient, index: pineconeIndex };

  if (!isPineconeConfigured()) {
    pineconeUnavailable = true;
    throw new Error('Pinecone is not configured. Set PINECONE_API_KEY and PINECONE_INDEX_NAME.');
  }

  if (!PineconePkg) {
    pineconeUnavailable = true;
    throw new Error('@pinecone-database/pinecone not installed');
  }

  const clientOpts = buildPineconeClientOptions();
  pineconeClient = new PineconePkg.Pinecone(clientOpts);
  pineconeIndex = (typeof pineconeClient.index === 'function')
    ? pineconeClient.index(env.pineconeIndexName)
    : pineconeClient.Index(env.pineconeIndexName);
  return { client: pineconeClient, index: pineconeIndex };
}

async function ensureIndex() {
  if (!isPineconeConfigured()) return null;

  try {
    if (!PineconePkg) throw new Error('@pinecone-database/pinecone package not installed');
    const clientOpts = buildPineconeClientOptions();
    const client = new PineconePkg.Pinecone(clientOpts);

    const indexes = await client.listIndexes();
    const indexList = Array.isArray(indexes) ? indexes : indexes?.indexes || [];
    const indexExists = indexList.some(idx => idx === env.pineconeIndexName || (idx && idx.name === env.pineconeIndexName));

    if (!indexExists) {
      const dim = Number(env.pineconeVectorDimension) || 1536;
      await client.createIndex({
        name: env.pineconeIndexName,
        dimension: dim,
        metric: 'cosine',
        spec: {
          serverless: {
            cloud: env.pineconeCloud || 'aws',
            region: env.pineconeRegion || 'us-east-1',
          },
        },
      });
    } else {
    }
  } catch (error) {
    console.warn('Unable to ensure Pinecone index exists:', error);
    throw error;
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

async function upsertLongTermVector({ id, vector, metadata, namespace }) {
  try {
    if (!id || !Array.isArray(vector) || vector.length === 0) {
      throw new Error('Pinecone upsert requires a vector id and non-empty vector');
    }
    const configuredDimension = Number(env.pineconeVectorDimension);
    if (configuredDimension > 0 && vector.length !== configuredDimension) {
      throw new Error(`Embedding dimension ${vector.length} does not match configured Pinecone dimension ${configuredDimension}`);
    }
    if (!metadata || typeof metadata.userId !== 'string' || !metadata.userId.trim()) {
      throw new Error('Pinecone episode metadata requires a userId string');
    }
    if (namespace !== 'episodes') {
      throw new Error('Pinecone episodic memory must use the episodes namespace');
    }

    const index = await getIndex();
    if (!index) {
      console.warn('[PINECONE_SKIPPED] upsert skipped: index unavailable');
      return false;
    }
    const payload = { records: [{ id, values: vector, metadata }], namespace };
    await index.upsert(payload);

    const verification = await verifyPineconeUpsert(index, id, namespace, metadata);
    return true;
  } catch (err) {
    pineconeUnavailable = true;
    console.warn('[PINECONE_SKIPPED] upsert failed:', err && err.message ? err.message : err);
    return false;
  }
}

async function deleteLongTermVector(id, namespace) {
  try {
    const index = await getIndex();
    if (!index) {
      console.warn('[PINECONE_SKIPPED] delete skipped: index unavailable');
      return false;
    }
    const payload = { id };
    if (namespace) payload.namespace = namespace;
    await index.deleteOne(payload);
    return true;
  } catch (err) {
    pineconeUnavailable = true;
    console.warn('[PINECONE_SKIPPED] delete failed:', err && err.message ? err.message : err);
    return false;
  }
}

async function deleteLongTermVectorsByMetadata(filter, namespace) {
  try {
    const index = await getIndex();
    if (!index) {
      return { deleted: false, count: 0, error: 'Pinecone index unavailable' };
    }
    if (!filter || typeof filter !== 'object' || Object.keys(filter).length === 0) {
      return { deleted: false, count: 0, error: 'Metadata filter is required' };
    }
    if (typeof index.deleteMany !== 'function') {
      return { deleted: false, count: 0, error: 'Installed Pinecone SDK does not support filtered deleteMany' };
    }

    const options = { filter };
    if (namespace) options.namespace = namespace;
    await index.deleteMany(options);
    return { deleted: true, count: 0, filter, namespace: namespace || null };
  } catch (err) {
    pineconeUnavailable = true;
    return { deleted: false, count: 0, error: err.message || String(err) };
  }
}

async function queryLongTermVectors({ vector, topK = 10, filter = {}, namespace }) {
  try {
    const index = await getIndex();
    if (!index) {
      console.warn('[PINECONE_SKIPPED] query skipped: index unavailable');
      return [];
    }

    const queryPayload = {
      vector,
      topK,
      includeMetadata: true,
      includeValues: false,
    };
    if (filter && Object.keys(filter).length > 0) queryPayload.filter = filter;
    if (namespace) queryPayload.namespace = namespace;
    const results = await index.query(queryPayload);

    return results.matches || [];
  } catch (err) {
    pineconeUnavailable = true;
    console.warn('[PINECONE_SKIPPED] query failed:', err && err.message ? err.message : err);
    return [];
  }
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyPineconeUpsert(index, id, namespace, metadata) {
  let lastError = null;
  const attempts = 2;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const fetched = await index.fetch({ ids: [id], namespace: namespace });
      const vec = fetched?.vectors?.[id] || null;
      if (vec) {
        const dim = Array.isArray(vec.values) ? vec.values.length : (vec?.values?.length || 0);
        return {
          status: 'fetch_ok',
          meta: {
            metadata: vec.metadata || metadata,
            vectorLength: dim,
            host: env.pineconeHost || null,
            verifyAttempts: attempt,
          },
        };
      }
      lastError = new Error('fetch returned no vector');
    } catch (err) {
      lastError = err;
    }
    if (attempt < attempts) {
      await delay(250);
    }
  }

  return {
    status: 'fetch_missing',
    meta: {
      metadata,
      vectorLength: null,
      host: env.pineconeHost || null,
      verificationError: lastError && lastError.message ? lastError.message : String(lastError),
      verifyAttempts: attempts,
    },
  };
}

async function fetchLongTermByIds(ids = [], namespace) {
  try {
    const index = await getIndex();
    if (!index) {
      console.warn('[PINECONE_SKIPPED] fetch skipped: index unavailable');
      return {};
    }
    if (!Array.isArray(ids) || ids.length === 0) return {};
    const payload = { ids };
    if (namespace) payload.namespace = namespace;
    const fetched = await index.fetch(payload);
    return fetched.vectors || {};
  } catch (err) {
    pineconeUnavailable = true;
    console.warn('[PINECONE_SKIPPED] fetch failed:', err && err.message ? err.message : err);
    return {};
  }
}

module.exports = {
  initPinecone,
  ensureIndex,
  getIndex,
  upsertLongTermVector,
  deleteLongTermVector,
  deleteLongTermVectorsByMetadata,
  queryLongTermVectors,
  fetchLongTermByIds,
  isPineconeConfigured,
  validateConfiguration,
  _pineconeUnavailable: () => pineconeUnavailable,
};
