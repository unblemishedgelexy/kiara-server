'use strict';

const redis = require('redis');
const { env } = require('../../config/env');

const REDIS_LOGGING_ENABLED = (process.env.REDIS_LOGGING || '').toLowerCase() === 'true';

function logRedis(level, ...args) {
  if (!REDIS_LOGGING_ENABLED) return;
  if (level === 'error') console.error(...args);
  else if (level === 'warn') console.warn(...args);
  else console.log(...args);
}

function createRedisService({ createClient = redis.createClient, configuration = env } = {}) {
  let redisClient = null;
  let redisInitPromise = null;
  let lastErrorCode = null;
  let lastFailureStage = null;

  function buildSocketOptions() {
    const options = {
      socket: {
        host: configuration.redisHost,
        port: configuration.redisPort,
      },
      database: configuration.redisDb,
    };

    if (configuration.redisPassword) {
      options.password = configuration.redisPassword;
    }

    return options;
  }

  function buildConnectionOptions() {
    return configuration.redisUrl
      ? { url: configuration.redisUrl }
      : buildSocketOptions();
  }

  async function connectClient(connectionOptions) {
    const client = createClient({
      ...connectionOptions,
      socket: {
        ...(connectionOptions.socket || {}),
        connectTimeout: 5000,
        reconnectStrategy: (retries) => {
          if (retries >= 5) return new Error('Redis connection retry limit exceeded');
          return Math.min(200 + retries * 200, 2000);
        },
      },
    });
    redisClient = client;

    client.on('error', (error) => {
      lastErrorCode = error?.code || error?.name || 'connection_error';
      lastFailureStage = 'socket';
      logRedis('error', '[REDIS_ERROR]', lastErrorCode);
    });
    client.on('ready', () => {
      logRedis('info', '[REDIS_READY]');
    });
    client.on('reconnecting', () => {
      lastFailureStage = 'reconnecting';
      logRedis('warn', '[REDIS_RECONNECTING]');
    });
    client.on('end', () => {
      if (redisClient === client) {
        redisClient = null;
      }
      lastFailureStage = 'connection-ended';
      logRedis('warn', '[REDIS_DISCONNECTED]');
    });

    let failureStage = 'connect';
    try {
      await client.connect();
      failureStage = 'ping';
      const ping = await client.ping();
      if (redisClient !== client || !client.isReady || ping !== 'PONG') {
        const error = new Error('Redis did not remain ready after connection validation.');
        error.code = 'REDIS_UNAVAILABLE';
        failureStage = 'validation';
        throw error;
      }
      lastErrorCode = null;
      lastFailureStage = null;
      return client;
    } catch (error) {
      lastErrorCode = error?.code || error?.name || 'connection_error';
      lastFailureStage = error?.code === 'REDIS_UNAVAILABLE' ? 'validation' : failureStage;
      if (redisClient === client) {
        redisClient = null;
      }
      if (client.isOpen) {
        await client.disconnect().catch((disconnectError) => {
          logRedis('warn', '[REDIS_CLOSE_ERROR]', disconnectError?.code || disconnectError?.name || 'connection_error');
        });
      }
      throw error;
    }
  }

  async function initRedisInternal() {
    if (configuration.redisUrl) {
      try {
        return await connectClient({ url: configuration.redisUrl });
      } catch (urlError) {
        if (!configuration.redisHost) {
          throw urlError;
        }
        logRedis('warn', '[REDIS_CONNECT_FAILED]', 'REDIS_URL', urlError?.code || urlError?.name || 'connection_error');
      }
    }

    return connectClient(buildSocketOptions());
  }

  async function initRedis() {
    if (redisClient?.isReady) {
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

  async function getRedisClient() {
    if (redisInitPromise) {
      await redisInitPromise;
    } else if (!redisClient || !redisClient.isOpen) {
      redisClient = null;
      await initRedis();
    }
    if (!redisClient || !redisClient.isReady) {
      lastErrorCode ||= 'REDIS_UNAVAILABLE';
      lastFailureStage ||= 'client-not-ready';
      const error = new Error('Redis is unavailable');
      error.code = 'REDIS_UNAVAILABLE';
      throw error;
    }
    return redisClient;
  }

  async function closeRedis() {
    const client = redisClient;
    redisClient = null;
    if (client) {
      try {
        await client.quit();
      } catch (error) {
        logRedis('warn', '[REDIS_CLOSE_ERROR]', error?.code || error?.name || 'connection_error');
      }
    }
  }

  function getRedisDiagnostics() {
    return {
      connectionSource: configuration.redisUrl ? 'url' : 'host-port',
      clientPresent: Boolean(redisClient),
      isOpen: redisClient?.isOpen === true,
      isReady: redisClient?.isReady === true,
      initializationInProgress: Boolean(redisInitPromise),
      lastErrorCode,
      lastFailureStage,
    };
  }

  return { initRedis, getRedisClient, closeRedis, getRedisDiagnostics };
}

const defaultRedisService = createRedisService();

module.exports = {
  initRedis: defaultRedisService.initRedis,
  getRedisClient: defaultRedisService.getRedisClient,
  closeRedis: defaultRedisService.closeRedis,
  getRedisDiagnostics: defaultRedisService.getRedisDiagnostics,
  createRedisService,
};
