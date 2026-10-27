'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

test('logs sanitized token failures and preserves safe structured error fields', async () => {
  const servicePath = require.resolve('./liveTokenService');
  const geminiServicePath = require.resolve('./geminiService');
  const previousService = require.cache[servicePath];
  const previousGeminiService = require.cache[geminiServicePath];
  const originalError = console.error;
  const sensitiveMessage = 'PRIVATE_PROMPT and ephemeral-token-value';
  const providerError = Object.assign(new Error(sensitiveMessage), {
    code: 'PROVIDER_ERROR',
    statusCode: 502,
  });
  const logs = [];

  require.cache[geminiServicePath] = {
    id: geminiServicePath,
    filename: geminiServicePath,
    loaded: true,
    exports: {
      createLiveEphemeralToken: async () => {
        throw providerError;
      },
    },
  };
  console.error = (...args) => logs.push(args);

  try {
    delete require.cache[servicePath];
    const service = require('./liveTokenService');
    await assert.rejects(
      service.createLiveEphemeralToken('private-user-id', { traceId: 'safe-trace' }),
      (error) => error.message === sensitiveMessage
        && error.code === 'PROVIDER_ERROR'
        && error.statusCode === 502,
    );

    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], '[LIVE_TOKEN_SERVICE_FAILED]');
    assert.equal(logs[0][1].includes(sensitiveMessage), false);
    assert.equal(logs[0][1].includes('private-user-id'), false);
    assert.deepEqual(JSON.parse(logs[0][1]), {
      traceId: 'safe-trace',
      errorName: 'Error',
      errorCode: 'PROVIDER_ERROR',
      statusCode: 502,
    });
  } finally {
    console.error = originalError;
    delete require.cache[servicePath];
    if (previousService) require.cache[servicePath] = previousService;
    if (previousGeminiService) require.cache[geminiServicePath] = previousGeminiService;
    else delete require.cache[geminiServicePath];
  }
});
