const redis = require('redis');
const { env } = require('../config/env');

let redisClient = null;

async function initRedis() {
  if (redisClient) return redisClient;

  try {
    const options = {};

    if (env.redisUrl) {
      options.url = env.redisUrl;
      console.log('Redis using REDIS_URL for connection');
    } else {
      options.socket = {
        host: env.redisHost,
        port: env.redisPort,
      };
      options.database = env.redisDb;

      if (env.redisPassword) {
        options.password = env.redisPassword;
      }
    }

    redisClient = redis.createClient(options);

    redisClient.on('error', (err) => {
      console.error('Redis Client Error:', err);
    });

    await redisClient.connect();
    const pingResult = await redisClient.ping();
    console.log(`Redis connected successfully (${pingResult})`);
    return redisClient;
  } catch (error) {
    console.error('Failed to initialize Redis:', error);
    throw error;
  }
}

async function getRedisClient() {
  if (!redisClient) {
    await initRedis();
  }
  return redisClient;
}

// Save short-term memory to Redis
async function saveShortTermMemory(userId, sessionId, role, message) {
  try {
    const client = await getRedisClient();
    const key = `memory:short:${userId}:${sessionId}`;
    const item = JSON.stringify({
      userId,
      sessionId,
      role,
      message,
      timestamp: new Date().toISOString(),
    });

    await client.rPush(key, item);
    await client.lTrim(key, -100, -1);
    await client.expire(key, env.shortTermMemoryTTL);
    return { success: true, key };
  } catch (error) {
    console.error('Error saving to Redis:', error);
    throw error;
  }
}

// Get short-term memory from Redis
async function getShortTermMemory(userId, sessionId) {
  try {
    const client = await getRedisClient();
    const key = `memory:short:${userId}:${sessionId}`;
    const items = await client.lRange(key, 0, -1);

    if (!items || items.length === 0) {
      return [];
    }

    return items.reduce((acc, item) => {
      try {
        acc.push(JSON.parse(item));
      } catch {
        // Skip invalid items
      }
      return acc;
    }, []);
  } catch (error) {
    console.error('Error retrieving from Redis:', error);
    throw error;
  }
}

// Delete short-term memory from Redis
async function deleteShortTermMemory(userId, sessionId) {
  try {
    const client = await getRedisClient();
    const key = `memory:short:${userId}:${sessionId}`;
    const result = await client.del(key);
    return { success: true, deleted: result > 0 };
  } catch (error) {
    console.error('Error deleting from Redis:', error);
    throw error;
  }
}

// Get all short-term memories for a user
async function getUserShortTermMemories(userId) {
  try {
    const client = await getRedisClient();
    const pattern = `memory:short:${userId}:*`;
    const keys = await client.keys(pattern);
    
    const memories = [];
    for (const key of keys) {
      const items = await client.lRange(key, 0, -1);
      for (const item of items) {
        try {
          memories.push(JSON.parse(item));
        } catch {
          // Skip invalid items
        }
      }
    }

    return memories;
  } catch (error) {
    console.error('Error retrieving user memories from Redis:', error);
    throw error;
  }
}

// Close Redis connection
async function closeRedis() {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

module.exports = {
  initRedis,
  getRedisClient,
  saveShortTermMemory,
  getShortTermMemory,
  deleteShortTermMemory,
  getUserShortTermMemories,
  closeRedis,
};
