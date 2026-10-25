const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const redisAbuseProtection = require('./redisAbuseProtection');

function createRequest() {
  const req = new EventEmitter();
  req.ip = '192.0.2.10';
  req.socket = {};
  return req;
}

function createResponse() {
  const res = new EventEmitter();
  res.headers = {};
  res.status = function status(code) {
    this.statusCode = code;
    return this;
  };
  res.setHeader = function setHeader(name, value) {
    this.headers[name] = value;
  };
  res.json = function json(body) {
    this.body = body;
    return this;
  };
  return res;
}

test('fails closed when Redis is unavailable', async () => {
  const req = createRequest();
  const res = createResponse();
  let nextCalled = false;
  const middleware = redisAbuseProtection({
    getClient: async () => {
      throw Object.assign(new Error('unavailable'), { code: 'REDIS_UNAVAILABLE' });
    },
  });

  await middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'ABUSE_PROTECTION_UNAVAILABLE');
});

test('releases an acquired permit when the response closes', async () => {
  const calls = [];
  const client = {
    eval: async (script, options) => {
      calls.push({ script, options });
      return script.includes('EXISTS') ? [1, 1000] : 1;
    },
  };
  const req = createRequest();
  const res = createResponse();
  let nextCalled = false;
  const middleware = redisAbuseProtection({ getClient: async () => client });

  await middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  res.emit('finish');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 2);
  assert.ok(calls[1].script.includes('ZREM'));
});

test('uses the configured auth admission limits and does not extend a block for concurrent requests', async () => {
  let acquireOptions;
  let acquireScript;
  const client = {
    eval: async (script, options) => {
      if (script.includes('EXISTS')) {
        acquireOptions = options;
        acquireScript = script;
        return [0, 5000];
      }
      return 1;
    },
  };
  const req = createRequest();
  const res = createResponse();
  const middleware = redisAbuseProtection({
    scope: 'ip',
    bucket: 'auth',
    maxInFlightPerIp: 20,
    burstMax: 120,
    burstWindowSeconds: 10,
    blockSeconds: 30,
    leaseSeconds: 120,
    getClient: async () => client,
  });

  await middleware(req, res, () => assert.fail('blocked request must not continue'));

  assert.equal(acquireOptions.arguments[0], '20');
  assert.equal(acquireOptions.arguments[1], '120');
  assert.equal(acquireOptions.arguments[2], '10000');
  assert.equal(acquireOptions.arguments[3], '30000');
  assert.equal(acquireOptions.arguments[4], '120000');
  assert.match(acquireOptions.keys[0], /kiara:abuse:auth:ip:/);
  assert.match(acquireScript, /ZCARD[\s\S]*?return \{0, math\.max\(1000, retryAfter\)\}[\s\S]*?INCR/);
  assert.equal(acquireScript.slice(acquireScript.indexOf('if redis.call(\'ZCARD\''), acquireScript.indexOf('local burst')).includes("SET', KEYS[1]"), false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['Retry-After'], '5');
  assert.equal(res.body.retryAfterSeconds, 5);
  assert.match(res.body.message, /wait 5 seconds/);
});

test('allows a route excluded by a narrower admission policy without consulting Redis', async () => {
  const req = createRequest();
  req.path = '/auth/login';
  const res = createResponse();
  let nextCalled = false;
  const middleware = redisAbuseProtection({
    skip: (request) => request.path === '/auth' || request.path.startsWith('/auth/'),
    getClient: async () => assert.fail('excluded requests must not consult Redis'),
  });

  await middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, undefined);
});

test('checks IP buckets and account admission concurrently while retaining every permit', async () => {
  const calls = [];
  let activeCalls = 0;
  let maxConcurrentCalls = 0;
  const client = {
    eval: async (script, options) => {
      calls.push({ script, options });
      if (!script.includes('EXISTS')) return 1;
      activeCalls += 1;
      maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeCalls -= 1;
      return [1, 1000];
    },
  };
  const req = createRequest();
  req.userId = 'synthetic-user';
  const res = createResponse();
  let nextCalled = false;
  const middleware = redisAbuseProtection({
    scope: 'account-ip',
    bucket: 'api-protected',
    additionalIpBuckets: ['api'],
    getClient: async () => client,
  });

  await middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(maxConcurrentCalls, 3);
  assert.equal(calls.filter(({ script }) => script.includes('EXISTS')).length, 3);
  assert.deepEqual(
    calls.filter(({ script }) => script.includes('EXISTS'))
      .map(({ options }) => options.keys[0].replace(/:[a-f0-9]{64}:blocked$/, ':*:blocked'))
      .sort(),
    [
      'kiara:abuse:api:ip:*:blocked',
      'kiara:abuse:api-protected:account:*:blocked',
      'kiara:abuse:api-protected:ip:*:blocked',
    ].sort(),
  );

  res.emit('finish');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter(({ script }) => script.includes("return redis.call('ZREM'")).length, 3);
});

test('releases successful parallel permits when another admission bucket blocks', async () => {
  const calls = [];
  const client = {
    eval: async (script, options) => {
      calls.push({ script, options });
      if (!script.includes('EXISTS')) return 1;
      return options.keys[0].includes(':api:ip:')
        ? [0, 5000]
        : [1, 1000];
    },
  };
  const req = createRequest();
  req.userId = 'synthetic-user';
  const res = createResponse();
  let nextCalled = false;
  const middleware = redisAbuseProtection({
    scope: 'account-ip',
    bucket: 'api-protected',
    additionalIpBuckets: ['api'],
    getClient: async () => client,
  });

  await middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['Retry-After'], '5');
  assert.equal(calls.filter(({ script }) => script.includes("return redis.call('ZREM'")).length, 2);
});
