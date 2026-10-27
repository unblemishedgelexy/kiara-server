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
