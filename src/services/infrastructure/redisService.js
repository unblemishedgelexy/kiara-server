const redis = require('redis');
const { env } = require('../../config/env');

const REDIS_LOGGING_ENABLED = (process.env.REDIS_LOGGING || '').toLowerCase() === 'true';

function logRedis(level, ...args) {
  if (!REDIS_LOGGING_ENABLED) return;
  if (level === 'error') console.error(...args);
  else if (level === 'warn') console.warn(...args);
  else console.log(...args);
}

let redisClient = null;
let redisInitPromise = null;

async function initRedis() {
  if (redisClient) {
    return redisClient;
  }
  if (redisInitPromise) {
    return redisInitPromise;
  }

  redisInitPromise = initRedisInternal();
  try {
    return await redisInitPromise;
  } finally {
    redisInitPromise = null;
  }
}

async function initRedisInternal() {
  async function connectClient(options, description) {
    const client = redis.createClient({
      ...options,
      socket: {
        ...(options.socket || {}),
        reconnectStrategy: (retries) => {
          return Math.min(200 + retries * 200, 2000);
        },
      },
    });

    client.on('error', (err) => {
      logRedis('error', '[REDIS_ERROR]', err instanceof Error ? err.message : err);
    });
    client.on('ready', () => {
      logRedis('info', '[REDIS_READY]');
    });
    client.on('reconnecting', () => {
      logRedis('warn', '[REDIS_RECONNECTING]');
    });
    client.on('end', () => {
      logRedis('warn', '[REDIS_DISCONNECTED]');
    });

    await client.connect();
    await client.ping();
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
        redisClient = await connectClient({ url: env.redisUrl }, 'REDIS_URL');
        return redisClient;
      } catch (urlError) {
        if (env.redisHost) {
          try {
            redisClient = await connectClient(buildSocketOptions(), 'host/port');
            return redisClient;
          } catch (socketError) {
            console.error('[ERROR]', 'Failed to initialize Redis fallback:', socketError instanceof Error ? socketError.message : socketError);
            throw socketError;
          }
        }
        throw urlError;
      }
    }

    const options = buildSocketOptions();
    redisClient = await connectClient(options, 'host/port');
    return redisClient;
  } catch (error) {
    console.error('[ERROR]', 'Failed to initialize Redis:', error instanceof Error ? error.message : error);
    throw error;
  }
}

async function getRedisClient() {
  if (!redisClient) {
    await initRedis();
  }
  if (!redisClient || !redisClient.isReady) {
    const error = new Error('Redis is unavailable');
    error.code = 'REDIS_UNAVAILABLE';
    throw error;
  }
  return redisClient;
}

// Close Redis connection
async function closeRedis() {
  if (redisClient) {
    try {
      await redisClient.quit();
    } catch (error) {
      logRedis('warn', '[REDIS_CLOSE_ERROR]', error instanceof Error ? error.message : error);
    }
    redisClient = null;
  }
}

module.exports = {
  initRedis,
  getRedisClient,
  closeRedis,
};
