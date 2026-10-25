const test = require('node:test');
const assert = require('node:assert/strict');
const { env } = require('../config/env');
const { GEMINI_TEXT_MODEL } = require('../config/constants');
const { shouldFallbackToGroq } = require('./aiController');

test('text failover is limited to configured Groq and transient default-model requests', () => {
  const originalEnabled = env.groqTextFallbackEnabled;
  const originalApiKey = env.groqApiKey;
  try {
    env.groqTextFallbackEnabled = true;
    env.groqApiKey = 'test-only';

    assert.equal(shouldFallbackToGroq({ status: 503 }, {}), true);
    assert.equal(shouldFallbackToGroq({ status: 429 }, { model: GEMINI_TEXT_MODEL }), true);
    assert.equal(shouldFallbackToGroq({ status: 401 }, {}), false);
    assert.equal(shouldFallbackToGroq({ status: 503 }, { model: 'custom-model' }), false);
    assert.equal(shouldFallbackToGroq({ status: 503 }, { candidateCount: 2 }), false);

    env.groqTextFallbackEnabled = false;
    assert.equal(shouldFallbackToGroq({ status: 503 }, {}), false);
  } finally {
    env.groqTextFallbackEnabled = originalEnabled;
    env.groqApiKey = originalApiKey;
  }
});
