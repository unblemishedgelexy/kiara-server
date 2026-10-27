'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGeminiLiveSystemInstruction } = require('../../config/constants');
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

test('uses Kiara Live system instructions when no session override is provided', () => {
  const connectConfig = createLiveConnectConfig(createLiveSessionConfig());

  assert.ok(LIVE_SYSTEM_INSTRUCTION.startsWith(buildGeminiLiveSystemInstruction()));
  assert.equal(connectConfig.systemInstruction, LIVE_SYSTEM_INSTRUCTION);
  assert.match(connectConfig.systemInstruction, /KIARA PRODUCT \/ CREATOR CONTEXT/);
});

test('prioritizes accurate factual answers using authenticated context', () => {
  assert.match(
    LIVE_SYSTEM_INSTRUCTION,
    /answer it accurately using relevant current authenticated context/i,
  );
});

test('instructs Kiara to emit a talk gesture for ordinary spoken replies', () => {
  assert.match(
    LIVE_SYSTEM_INSTRUCTION,
    /"gesture":"talk"/i,
  );
});

test('keeps app-control JSON out of spoken audio', () => {
  assert.match(LIVE_SYSTEM_INSTRUCTION, /private app-control metadata, not dialogue/i);
  assert.match(LIVE_SYSTEM_INSTRUCTION, /never read its keys, values, braces, or formatting aloud/i);
  assert.match(LIVE_SYSTEM_INSTRUCTION, /Speak only the natural-language reply/i);
});

test('preserves the configured Live reply style and prevents repeated spoken answers', () => {
  assert.match(LIVE_SYSTEM_INSTRUCTION, /Keep spoken replies concise, usually one or two sentences/i);
  assert.match(LIVE_SYSTEM_INSTRUCTION, /Do not repeat the JSON or spoken reply within the same turn/i);
});
