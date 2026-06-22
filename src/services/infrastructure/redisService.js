const redis = require('redis');
const { env } = require('../../config/env');

let redisClient = null;

async function initRedis() {
  if (redisClient) return redisClient;

  async function connectClient(options, description) {
    const client = redis.createClient(options);
    client.on('error', (err) => {
      console.error('Redis Client Error:', err);
    });

    await client.connect();
    const pingResult = await client.ping();
    console.log(`Redis connected successfully (${pingResult}) using ${description}`);
    return client;
  }

  const buildSocketOptions = () => {
    const options = {
      socket: {
        host: env.redisHost,
        port: env.redisPort,
      },
      database: env.redisDb,
    };

    if (env.redisPassword) {
      options.password = env.redisPassword;
    }

    return options;
  };

  try {
    if (env.redisUrl) {
      try {
        console.log('Redis using REDIS_URL for connection');
        redisClient = await connectClient({ url: env.redisUrl }, 'REDIS_URL');
        return redisClient;
      } catch (urlError) {
        console.error('Failed to initialize Redis with REDIS_URL:', urlError);
        if (env.redisHost) {
          try {
            console.log('Falling back to Redis host/port connection');
            redisClient = await connectClient(buildSocketOptions(), 'host/port');
            return redisClient;
          } catch (socketError) {
            console.error('Failed to initialize Redis with host/port fallback:', socketError);
            throw socketError;
          }
        }
        throw urlError;
      }
    }

    console.log('Redis using host/port for connection');
    const options = buildSocketOptions();
    redisClient = await connectClient(options, 'host/port');
    return redisClient;
  } catch (error) {
    console.error('Failed to initialize Redis:', error);
    throw error;
  }
}

function ensureUserId(userId) {
  if (!userId || typeof userId !== 'string' || !userId.trim()) {
    throw new Error('Redis short-term memory operations require a valid userId');
  }
  return userId.trim();
}

function ensureSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error('Redis short-term memory operations require a valid sessionId');
  }
  return sessionId.trim();
}

function buildShortTermKey(userId, sessionId) {
  return `memory:short:${ensureUserId(userId)}:${ensureSessionId(sessionId)}`;
}

function buildShortTermPattern(userId) {
  return `memory:short:${ensureUserId(userId)}:*`;
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
    const key = buildShortTermKey(userId, sessionId);
    const item = JSON.stringify({
      userId: ensureUserId(userId),
      sessionId: ensureSessionId(sessionId),
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
    const key = buildShortTermKey(userId, sessionId);
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
    const key = buildShortTermKey(userId, sessionId);
    const result = await client.del(key);
    return { success: true, deleted: result > 0 };
  } catch (error) {
    console.error('Error deleting from Redis:', error);
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
  closeRedis,
};
