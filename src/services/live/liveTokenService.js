const { createLiveEphemeralToken: createGeminiLiveToken } = require('./geminiService');

async function createLiveEphemeralToken(requestingUserId = null, options = {}) {
  try {
    return await createGeminiLiveToken(requestingUserId, options);
  } catch (error) {
    const errorName = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error.name)
      ? error.name
      : 'Error';
    const errorCode = typeof error?.code === 'string' && /^[A-Za-z0-9_.-]{1,48}$/.test(error.code)
      ? error.code
      : null;
    const statusCode = Number.isInteger(error?.statusCode)
      && error.statusCode >= 100
      && error.statusCode <= 599
      ? error.statusCode
      : null;
    const traceId = typeof options.traceId === 'string'
      && /^[A-Za-z0-9._:-]{1,128}$/.test(options.traceId)
      ? options.traceId
      : null;
    console.error('[LIVE_TOKEN_SERVICE_FAILED]', JSON.stringify({
      traceId,
      errorName,
      errorCode,
      statusCode,
    }));

    const wrappedError = new Error(
      error instanceof Error ? error.message : 'Failed to create live ephemeral token',
    );
    if (errorName === 'AbortError') wrappedError.name = 'AbortError';
    if (errorCode) wrappedError.code = errorCode;
    if (statusCode) wrappedError.statusCode = statusCode;
    throw wrappedError;
  }
}

module.exports = { createLiveEphemeralToken };
