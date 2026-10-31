'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { getProductionRedisConfigurationIssue } = require('../../config/env');
const { createRedisService } = require('./redisService');

function createFakeRedisClientFactory() {
  const clients = [];
  const createClient = (options) => {
    const client = new EventEmitter();
    client.options = options;
    client.isOpen = false;
    client.isReady = false;
    client.connect = async () => {
      await new Promise((resolve) => setImmediate(resolve));
      client.isOpen = true;
      client.isReady = true;
      client.emit('ready');
    };
    client.ping = async () => (client.isReady ? 'PONG' : null);
    client.disconnect = async () => {
      client.isReady = false;
      client.isOpen = false;
      client.emit('end');
    };
    client.quit = async () => client.disconnect();
    clients.push(client);
    return client;
  };
  return { createClient, clients };
}

test('production Redis configuration rejects missing or non-TLS URLs', () => {
  assert.equal(getProductionRedisConfigurationIssue({
    nodeEnv: 'production',
    redisUrl: '',
  }), 'REDIS_URL');
  assert.match(getProductionRedisConfigurationIssue({
    nodeEnv: 'production',
    redisUrl: 'redis://redis.example:6379',
  }), /must use TLS/);
  assert.match(getProductionRedisConfigurationIssue({
    nodeEnv: 'production',
    redisUrl: 'not-a-redis-url',
  }), /must be a valid Redis URL/);
  assert.equal(getProductionRedisConfigurationIssue({
    nodeEnv: 'production',
    redisUrl: 'rediss://redis.example:6380',
  }), '');
});

test('recreates a client after the connection ends and recovers readiness', async () => {
  const { createClient, clients } = createFakeRedisClientFactory();
  const service = createRedisService({
    createClient,
    configuration: { redisUrl: 'redis://localhost:6379' },
  });

  const firstClient = await service.getRedisClient();
  assert.equal(firstClient.isReady, true);

  firstClient.isReady = false;
  firstClient.isOpen = false;
  firstClient.emit('end');

  const recoveredClient = await service.getRedisClient();
  assert.notEqual(recoveredClient, firstClient);
  assert.equal(recoveredClient.isReady, true);
  assert.equal(clients.length, 2);

  await service.closeRedis();
  assert.equal(recoveredClient.isOpen, false);
  assert.equal(await service.getRedisClient().then(() => true), true);
  assert.equal(clients.length, 3);
  await service.closeRedis();
});

test('shares concurrent initialization and validates Redis with PING', async () => {
  const { createClient, clients } = createFakeRedisClientFactory();
  const service = createRedisService({
    createClient,
    configuration: {
      redisHost: 'localhost',
      redisPort: 6379,
      redisDb: 2,
      redisPassword: 'not-logged',
    },
  });

  const [first, second] = await Promise.all([
    service.getRedisClient(),
    service.getRedisClient(),
  ]);

  assert.equal(first, second);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].options.database, 2);
  assert.equal(clients[0].options.password, 'not-logged');
  assert.equal(await service.getRedisClient(), first);
  await service.closeRedis();
});

test('preserves configured host fallback when the Redis URL connection fails', async () => {
  const { createClient, clients } = createFakeRedisClientFactory();
  const service = createRedisService({
    createClient: (options) => {
      const client = createClient(options);
      if (options.url) {
        client.connect = async () => {
          throw Object.assign(new Error('connection failed'), { code: 'ECONNREFUSED' });
        };
      }
      return client;
    },
    configuration: {
      redisUrl: 'redis://remote.example:6379',
      redisHost: 'localhost',
      redisPort: 6379,
      redisDb: 1,
    },
  });

  const client = await service.getRedisClient();
  assert.equal(clients.length, 2);
  assert.equal(clients[0].options.url, 'redis://remote.example:6379');
  assert.equal(clients[1].options.socket.host, 'localhost');
  assert.equal(clients[1].options.database, 1);
  assert.equal(client, clients[1]);
  await service.closeRedis();
});

test('requires TLS and rejects insecure production Redis before connecting', async () => {
  const { createClient, clients } = createFakeRedisClientFactory();
  const service = createRedisService({
    createClient,
    configuration: {
      nodeEnv: 'production',
      redisUrl: 'redis://redis.example:6379',
      redisHost: 'localhost',
      redisPort: 6379,
    },
  });

  await assert.rejects(service.getRedisClient(), {
    code: 'REDIS_TLS_REQUIRED',
  });
  assert.equal(clients.length, 0);
});

test('enables certificate verification for production TLS Redis', async () => {
  const { createClient, clients } = createFakeRedisClientFactory();
  const service = createRedisService({
    createClient,
    configuration: {
      nodeEnv: 'production',
      redisUrl: 'rediss://redis.example:6380',
    },
  });

  const client = await service.getRedisClient();
  assert.equal(clients.length, 1);
  assert.equal(clients[0].options.socket.tls, true);
  assert.equal(clients[0].options.socket.rejectUnauthorized, true);
  await service.closeRedis();
});

test('does not fall back to plaintext host-port Redis in production', async () => {
  const { createClient, clients } = createFakeRedisClientFactory();
  const service = createRedisService({
    createClient: (options) => {
      const client = createClient(options);
      client.connect = async () => {
        throw Object.assign(new Error('TLS connection failed'), { code: 'ECONNREFUSED' });
      };
      return client;
    },
    configuration: {
      nodeEnv: 'production',
      redisUrl: 'rediss://redis.example:6380',
      redisHost: 'localhost',
      redisPort: 6379,
    },
  });

  await assert.rejects(service.getRedisClient(), { code: 'ECONNREFUSED' });
  assert.equal(clients.length, 1);
});

test('does not return a client that ends during connection validation', async () => {
  const { createClient, clients } = createFakeRedisClientFactory();
  let failFirstPing = true;
  const service = createRedisService({
    createClient: (options) => {
      const client = createClient(options);
      if (failFirstPing) {
        failFirstPing = false;
        client.ping = async () => {
          client.isReady = false;
          client.isOpen = false;
          client.emit('end');
          return 'PONG';
        };
      }
      return client;
    },
    configuration: { redisUrl: 'redis://localhost:6379' },
  });

  await assert.rejects(service.getRedisClient(), { code: 'REDIS_UNAVAILABLE' });
  assert.equal(clients.length, 1);
  assert.equal(await service.getRedisClient().then((client) => client.isReady), true);
  assert.equal(clients.length, 2);
  await service.closeRedis();
});
