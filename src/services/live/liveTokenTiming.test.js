'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getLiveTokenTraceId } = require('./liveTokenTiming');

test('preserves valid caller trace identifiers without logging stage events', () => {
  const traceId = getLiveTokenTraceId({
    headers: { 'x-kiara-trace-id': 'request-trace' },
    body: { prompt: 'must not be logged' },
  });

  assert.equal(traceId, 'request-trace');
});

test('replaces malformed caller trace identifiers', () => {
  const traceId = getLiveTokenTraceId({
    headers: { 'x-kiara-trace-id': 'bad\ntrace' },
    body: {},
  });

  assert.match(traceId, /^live-token-[0-9a-f-]{36}$/);
});
