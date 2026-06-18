const { env } = require('../config/env');
const mongoose = require('mongoose');
const redisService = require('./redisService');
const MemoryJob = require('../models/MemoryJob');
const MemoryProfile = require('../models/MemoryProfile');
const UnfinishedContext = require('../models/UnfinishedContext');
const redis = require('redis');

async function getRedisHealth() {
  try {
    const client = await redisService.getRedisClient();
    await client.ping();
    return true;
  } catch {
    return false;
  }
}

async function getPineconeHealth() {
  try {
    const pineconeService = require('./pineconeService');
    return pineconeService.isPineconeConfigured();
  } catch {
    return false;
  }
}

async function getMemoryHealth() {
  const [mongoConnected, redisConnected, pineconeConnected, memoryCount, profileCount, activeSessions, queuePending, queueFailed, bootstrapCount, unfinishedContextCount] = await Promise.all([
    Promise.resolve(mongoose.connection.readyState === 1),
    getRedisHealth(),
    getPineconeHealth(),
    require('../models/LongTermMemory').countDocuments(),
    MemoryProfile.countDocuments(),
    redisService.getRedisClient().then((client) => client.keys('session:active:*')).then((keys) => keys.length).catch(() => 0),
    MemoryJob.countDocuments({ status: 'pending' }),
    MemoryJob.countDocuments({ status: 'failed' }),
    redisService.getRedisClient().then((client) => client.keys('bootstrap:*')).then((keys) => keys.length).catch(() => 0),
    UnfinishedContext.countDocuments({ status: 'pending' }),
  ]);

  return {
    mongoConnected,
    redisConnected,
    pineconeConnected,
    memoryCount,
    profileCount,
    activeSessions,
    queuePending,
    queueFailed,
    bootstrapCacheCount: bootstrapCount,
    unfinishedContextCount,
  };
}

module.exports = { getMemoryHealth };