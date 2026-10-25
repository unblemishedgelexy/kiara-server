'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LIVE_SYSTEM_INSTRUCTION } = require('./liveSystemInstruction');
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

test('prioritizes accurate factual answers using authenticated context', () => {
  assert.match(
    LIVE_SYSTEM_INSTRUCTION,
    /For factual questions, prioritize accuracy and relevant authenticated context/i,
  );
});

test('instructs Kiara to emit a talk gesture for ordinary spoken replies', () => {
  assert.match(
    LIVE_SYSTEM_INSTRUCTION,
    /"gesture":"talk"/i,
  );
});

test('keeps Live instructions concise and prevents repeated spoken answers', () => {
  assert.ok(LIVE_SYSTEM_INSTRUCTION.length < 4000);
  assert.match(LIVE_SYSTEM_INSTRUCTION, /Do not restate the question, repeat a point you already made/i);
  assert.match(LIVE_SYSTEM_INSTRUCTION, /Do not repeat the JSON or spoken reply within the same turn/i);
});
