'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const { test } = require('node:test');
const { LIVE_SYSTEM_INSTRUCTION } = require('./liveSystemInstruction');

test('creates the Live token without waiting for optional memory prompt construction', async () => {
  const servicePath = require.resolve('./geminiService');
  const envPath = require.resolve('../../config/env');
  const sdkPath = require.resolve('@google/genai');
  const promptBuilderPath = require.resolve('./systemPromptBuilder');
  const previousService = require.cache[servicePath];
  const previousEnv = require.cache[envPath];
  const previousSdk = require.cache[sdkPath];
  const originalLoad = Module._load;
  const originalInfo = console.info;
  const infoLogs = [];
  let promptBuilderLoadCount = 0;
  let capturedConnectConfig;
  let capturedAbortSignal;

  require.cache[envPath] = {
    id: envPath,
    filename: envPath,
    loaded: true,
    exports: {
      env: {
        geminiApiKey: 'test-only-key',
        geminiLiveModel: 'gemini-3.1-flash-live-preview',
        geminiLiveVoice: 'Leda',
      },
    },
  };
  require.cache[sdkPath] = {
    id: sdkPath,
    filename: sdkPath,
    loaded: true,
    exports: {
      GoogleGenAI: class MockGoogleGenAI {
        constructor() {
          this.authTokens = {
            create: async ({ config }) => {
              capturedAbortSignal = config.abortSignal;
              capturedConnectConfig = config.liveConnectConstraints.config;
              return { name: 'mock-live-token' };
            },
          };
        }
      },
    },
  };
  console.info = (...args) => infoLogs.push(args);
  Module._load = function loadWithoutOptionalPrompt(request, parent, isMain) {
    if (request === './systemPromptBuilder' && parent?.filename === servicePath) {
      promptBuilderLoadCount += 1;
      throw new Error('Optional prompt builder must not run on the Live token path.');
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[servicePath];
    const geminiService = require('./geminiService');
    const startedAt = performance.now();
    const token = await geminiService.createLiveEphemeralToken('test-user', {
      traceId: 'startup-regression',
      lifecycleTrigger: 'LIVE_SESSION_START',
    });
    const elapsedMs = performance.now() - startedAt;

    assert.equal(token.token, 'mock-live-token');
    assert.equal(token.memoryContextStatus, 'DEFERRED_POST_CONNECT');
    assert.equal(token.sessionConfig.systemInstruction, LIVE_SYSTEM_INSTRUCTION);
    assert.equal(promptBuilderLoadCount, 0);
    assert.equal(capturedConnectConfig.systemInstruction, LIVE_SYSTEM_INSTRUCTION);
    assert.equal(token.sessionConfig.systemInstruction, capturedConnectConfig.systemInstruction);
    assert.ok(capturedAbortSignal instanceof AbortSignal);
    assert.equal(capturedAbortSignal.aborted, false);
    assert.ok(elapsedMs < 1000, `mock token path unexpectedly took ${elapsedMs} ms`);

    assert.equal(infoLogs.some(([label]) => label === '[LIVE_TOKEN_STAGE]'), false);
  } finally {
    Module._load = originalLoad;
    console.info = originalInfo;
    delete require.cache[servicePath];
    if (previousService) require.cache[servicePath] = previousService;
    if (previousEnv) require.cache[envPath] = previousEnv;
    else delete require.cache[envPath];
    if (previousSdk) require.cache[sdkPath] = previousSdk;
    else delete require.cache[sdkPath];
    delete require.cache[promptBuilderPath];
  }
});

test('aborts the provider token request when the caller disconnects', async () => {
  const servicePath = require.resolve('./geminiService');
  const envPath = require.resolve('../../config/env');
  const sdkPath = require.resolve('@google/genai');
  const previousService = require.cache[servicePath];
  const previousEnv = require.cache[envPath];
  const previousSdk = require.cache[sdkPath];
  const originalInfo = console.info;
  const infoLogs = [];
  let capturedAbortSignal;

  require.cache[envPath] = {
    id: envPath,
    filename: envPath,
    loaded: true,
    exports: {
      env: {
        geminiApiKey: 'test-only-key',
        geminiLiveModel: 'gemini-3.1-flash-live-preview',
        geminiLiveVoice: 'Leda',
      },
    },
  };
  require.cache[sdkPath] = {
    id: sdkPath,
    filename: sdkPath,
    loaded: true,
    exports: {
      GoogleGenAI: class MockGoogleGenAI {
        constructor() {
          this.authTokens = {
            create: ({ config }) => new Promise((_resolve, reject) => {
              capturedAbortSignal = config.abortSignal;
              config.abortSignal.addEventListener('abort', () => {
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              }, { once: true });
            }),
          };
        }
      },
    },
  };
  console.info = (...args) => infoLogs.push(args);

  try {
    delete require.cache[servicePath];
    const geminiService = require('./geminiService');
    const controller = new AbortController();
    const pendingToken = geminiService.createLiveEphemeralToken('test-user', {
      traceId: 'abort-regression',
      signal: controller.signal,
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(capturedAbortSignal instanceof AbortSignal);
    controller.abort();
    await assert.rejects(pendingToken, { name: 'AbortError' });

    assert.equal(infoLogs.some(([label]) => label === '[LIVE_TOKEN_STAGE]'), false);
  } finally {
    console.info = originalInfo;
    delete require.cache[servicePath];
    if (previousService) require.cache[servicePath] = previousService;
    if (previousEnv) require.cache[envPath] = previousEnv;
    else delete require.cache[envPath];
    if (previousSdk) require.cache[sdkPath] = previousSdk;
    else delete require.cache[sdkPath];
  }
});

test('uses the signed Live gateway when it is configured', async () => {
  const servicePath = require.resolve('./geminiService');
  const envPath = require.resolve('../../config/env');
  const sdkPath = require.resolve('@google/genai');
  const previousService = require.cache[servicePath];
  const previousEnv = require.cache[envPath];
  const previousSdk = require.cache[sdkPath];
  const previousFetch = global.fetch;
  const originalInfo = console.info;
  const infoLogs = [];
  const signingSecret = 'test-secret-with-more-than-thirty-two-bytes';
  let fetchRequest;
  let sdkClientCreated = false;

  require.cache[envPath] = {
    id: envPath,
    filename: envPath,
    loaded: true,
    exports: {
      env: {
        geminiApiKey: '',
        geminiLiveModel: 'gemini-3.1-flash-live-preview',
        geminiLiveVoice: 'Leda',
        liveGatewayUrl: 'http://127.0.0.1:8080',
        liveGatewayHmacSecret: signingSecret,
      },
    },
  };
  require.cache[sdkPath] = {
    id: sdkPath,
    filename: sdkPath,
    loaded: true,
    exports: {
      GoogleGenAI: class MockGoogleGenAI {
        constructor() {
          sdkClientCreated = true;
        }
      },
    },
  };
  global.fetch = async (url, options) => {
    fetchRequest = { url: String(url), ...options };
    return new Response(JSON.stringify({ token: 'gateway-live-token' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  console.info = (...args) => infoLogs.push(args);

  try {
    delete require.cache[servicePath];
    const geminiService = require('./geminiService');
    const token = await geminiService.createLiveEphemeralToken('test-user', {
      lifecycleTrigger: 'LIVE_SESSION_START',
    });

    assert.equal(token.token, 'gateway-live-token');
    assert.deepEqual(
      infoLogs.filter(([label]) => label === '[LIVE_GATEWAY_CONNECTION]'),
      [['[LIVE_GATEWAY_CONNECTION]', '{"status":"reachable","httpStatus":200}']],
    );
    assert.deepEqual(
      infoLogs.filter(([label]) => label === '[LIVE_GATEWAY_TOKEN_RECEIVED]'),
      [['[LIVE_GATEWAY_TOKEN_RECEIVED]', '{"status":"success","httpStatus":200}']],
    );
    assert.equal(fetchRequest.url, 'http://127.0.0.1:8080/internal/v1/live-token');
    assert.equal(fetchRequest.method, 'POST');
    assert.equal(sdkClientCreated, false);

    const { createHash, createHmac } = require('node:crypto');
    const bodyHash = createHash('sha256').update(fetchRequest.body).digest('hex');
    const expectedSignature = createHmac('sha256', signingSecret)
      .update(`${fetchRequest.headers['x-kiara-timestamp']}.${fetchRequest.headers['x-kiara-nonce']}.${bodyHash}`)
      .digest('hex');
    assert.equal(fetchRequest.headers['x-kiara-signature'], expectedSignature);
    assert.equal(JSON.parse(fetchRequest.body).liveConnectConstraints.config.systemInstruction, LIVE_SYSTEM_INSTRUCTION);
    assert.ok(fetchRequest.signal instanceof AbortSignal);
  } finally {
    global.fetch = previousFetch;
    console.info = originalInfo;
    delete require.cache[servicePath];
    if (previousService) require.cache[servicePath] = previousService;
    if (previousEnv) require.cache[envPath] = previousEnv;
    else delete require.cache[envPath];
    if (previousSdk) require.cache[sdkPath] = previousSdk;
    else delete require.cache[sdkPath];
  }
});

test('logs an unreachable gateway without exposing its URL or signing secret', async () => {
  const servicePath = require.resolve('./geminiService');
  const envPath = require.resolve('../../config/env');
  const sdkPath = require.resolve('@google/genai');
  const previousService = require.cache[servicePath];
  const previousEnv = require.cache[envPath];
  const previousSdk = require.cache[sdkPath];
  const previousFetch = global.fetch;
  const originalError = console.error;
  const errorLogs = [];
  const signingSecret = 'test-secret-with-more-than-thirty-two-bytes';

  require.cache[envPath] = {
    id: envPath,
    filename: envPath,
    loaded: true,
    exports: {
      env: {
        geminiApiKey: '',
        geminiLiveModel: 'gemini-3.1-flash-live-preview',
        geminiLiveVoice: 'Leda',
        liveGatewayUrl: 'https://gateway-secret-host.example',
        liveGatewayHmacSecret: signingSecret,
      },
    },
  };
  require.cache[sdkPath] = {
    id: sdkPath,
    filename: sdkPath,
    loaded: true,
    exports: { GoogleGenAI: class MockGoogleGenAI {} },
  };
  global.fetch = async () => {
    throw Object.assign(new Error('connection failed'), { code: 'ECONNREFUSED' });
  };
  console.error = (...args) => errorLogs.push(args);

  try {
    delete require.cache[servicePath];
    const geminiService = require('./geminiService');
    await assert.rejects(
      geminiService.createLiveEphemeralToken('test-user'),
      /connection failed/,
    );

    const connectionLog = errorLogs.find(([label]) => label === '[LIVE_GATEWAY_CONNECTION]');
    assert.ok(connectionLog);
    assert.deepEqual(JSON.parse(connectionLog[1]), {
      status: 'unreachable',
      errorCode: 'ECONNREFUSED',
    });
    assert.equal(JSON.stringify(errorLogs).includes(signingSecret), false);
    assert.equal(JSON.stringify(errorLogs).includes('gateway-secret-host.example'), false);
  } finally {
    global.fetch = previousFetch;
    console.error = originalError;
    delete require.cache[servicePath];
    if (previousService) require.cache[servicePath] = previousService;
    if (previousEnv) require.cache[envPath] = previousEnv;
    else delete require.cache[envPath];
    if (previousSdk) require.cache[sdkPath] = previousSdk;
    else delete require.cache[sdkPath];
  }
});
