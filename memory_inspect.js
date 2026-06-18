const dotenv = require('dotenv');
dotenv.config({ path: '.env' });
const mongoose = require('mongoose');
const redis = require('redis');
const { Pinecone } = require('@pinecone-database/pinecone');
const Chat = require('./src/models/Chat');
const Message = require('./src/models/Message');
const Summary = require('./src/models/Summary');
const LongTermMemory = require('./src/models/LongTermMemory');
const log = (...args) => console.log(...args);
(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    log('Mongo connected');
    const chatCount = await Chat.countDocuments();
    const messageCount = await Message.countDocuments();
    const summaryCount = await Summary.countDocuments();
    const ltmCount = await LongTermMemory.countDocuments();
    log('Mongo counts', JSON.stringify({ chatCount, messageCount, summaryCount, ltmCount }));
    const chatSample = await Chat.findOne().lean();
    const messageSample = await Message.findOne().lean();
    const summarySample = await Summary.findOne().lean();
    const ltmSample = await LongTermMemory.findOne().lean();
    log('Chat sample', chatSample ? JSON.stringify(chatSample, null, 2) : 'null');
    log('Message sample', messageSample ? JSON.stringify(messageSample, null, 2) : 'null');
    log('Summary sample', summarySample ? JSON.stringify(summarySample, null, 2) : 'null');
    log('LongTermMemory sample', ltmSample ? JSON.stringify(ltmSample, null, 2) : 'null');
  } catch (error) {
    console.error('Mongo error', error && error.toString ? error.toString() : error);
  }
  try {
    const client = redis.createClient({ url: process.env.REDIS_URL });
    client.on('error', (e) => log('Redis error', e.toString()));
    await client.connect();
    log('Redis connected');
    const keys = await client.keys('memory:short:*');
    log('Redis keys count', keys.length, keys.slice(0, 20));
    for (const key of keys.slice(0, 5)) {
      const values = await client.lRange(key, 0, -1);
      log('Redis key', key, 'length', values.length, 'first', values[0]);
    }
    await client.quit();
  } catch (error) {
    console.error('Redis error', error && error.toString ? error.toString() : error);
  }
  try {
    const apiKey = process.env.PINECONE_API_KEY;
    const indexName = process.env.PINECONE_INDEX_NAME;
    const dimension = Number(process.env.PINECONE_VECTOR_DIMENSION || '1536');
    if (!apiKey || !indexName) {
      log('Pinecone not configured');
    } else {
      const client = new Pinecone({ apiKey });
      const indexes = await client.listIndexes();
      log('Pinecone indexes', JSON.stringify(indexes));
      if (!indexes.includes(indexName)) {
        log('Pinecone index not found', indexName);
      } else {
        const index = client.Index(indexName);
        try {
          const desc = await index.describeIndexStats({ includeValues: false });
          log('Pinecone stats', JSON.stringify(desc, null, 2));
        } catch (err) {
          log('Pinecone describe failed', err && err.toString ? err.toString() : err);
        }
        try {
          const query = Array(dimension).fill(0.01);
          const result = await index.query({ vector: query, topK: 3, includeMetadata: true, includeValues: false });
          log('Pinecone sample query', JSON.stringify(result, null, 2));
        } catch (err) {
          log('Pinecone query failed', err && err.toString ? err.toString() : err);
        }
      }
    }
  } catch (error) {
    console.error('Pinecone error', error && error.toString ? error.toString() : error);
  }
  process.exit(0);
})();
