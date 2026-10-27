'use strict';

const { randomUUID } = require('node:crypto');

const LIVE_TOKEN_TRACE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function getLiveTokenTraceId(req) {
  const provided = req.headers?.['x-kiara-trace-id'] || req.body?.traceId;
  const traceId = typeof provided === 'string' && LIVE_TOKEN_TRACE_ID_PATTERN.test(provided)
    ? provided
    : `live-token-${randomUUID()}`;
  return traceId;
}

module.exports = {
  getLiveTokenTraceId,
};
