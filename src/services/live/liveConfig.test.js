'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GEMINI_LIVE_SYSTEM_INSTRUCTION } = require('../../config/constants');
const {
  createLiveConnectConfig,
  createLiveSessionConfig,
} = require('./liveConfig');

test('configures stable Live generation with the provided session instruction', () => {
  const sessionConfig = createLiveSessionConfig({
    model: 'gemini-3.1-flash-live-preview',
    systemInstruction: 'Session-scoped instruction',
    voiceName: 'Leda',
  });
  const connectConfig = createLiveConnectConfig(sessionConfig);

  assert.equal(connectConfig.temperature, 0.7);
  assert.equal(connectConfig.systemInstruction, 'Session-scoped instruction');
  assert.deepEqual(connectConfig.responseModalities, ['AUDIO']);
});

test('keeps conversational style guidance from overriding direct factual answers', () => {
  assert.match(
    GEMINI_LIVE_SYSTEM_INSTRUCTION,
    /When the user asks a direct factual question, answer it accurately using relevant current authenticated context/i,
  );
});
