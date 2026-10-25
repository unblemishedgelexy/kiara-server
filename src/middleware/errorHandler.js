const { env, isProductionEnv } = require('../config/env');

function errorHandler(err, req, res, next) {
  if (err?.message === 'CORS origin not allowed') {
    return res.status(403).json({
      success: false,
      message: 'CORS origin not allowed.',
      code: 'CORS_ORIGIN_NOT_ALLOWED',
    });
  }

  const isJsonSyntaxError = err.type === 'entity.parse.failed' || err instanceof SyntaxError;
  const errorText = String(err?.message || '').toLowerCase();
  const dependency = /redis|econnrefused|econnreset|mongo|mongoose|pinecone|gemini/.test(errorText)
    ? (errorText.includes('redis') ? 'redis' : errorText.includes('mongo') || errorText.includes('mongoose') ? 'mongodb' : errorText.includes('pinecone') ? 'pinecone' : 'gemini')
    : null;
  const status = err.status || (isJsonSyntaxError ? 400 : dependency ? 503 : 500);
  const message = err.message || 'Server error';
  const isServerError = status >= 500;
  const safeMessage = isProductionEnv() && isServerError ? 'Internal server error.' : message;

  if (isJsonSyntaxError) {
    const rawBodyLength = req?.rawBody ? String(req.rawBody).length : 0;
    const contentType = req?.headers?.['content-type'] || req?.headers?.['Content-Type'] || 'unknown';

    console.error('[BAD_JSON_REQUEST]', JSON.stringify({
      requestId: req?.requestId || null,
      method: req?.method,
      path: req?.path || null,
      contentType,
      rawBodyLength,
      message: 'Malformed JSON request body.',
    }));

    return res.status(400).json({
      success: false,
      error: 'Malformed JSON request body.',
      message: 'Malformed JSON request body.',
      code: 'BAD_JSON_REQUEST',
      requestId: req?.requestId,
    });
  }

  const response = { success: false, message: safeMessage };
  if (dependency) {
    response.dependency = dependency;
    response.status = 'UNAVAILABLE_DEPENDENCY';
  }
  if (!isProductionEnv()) {
    response.error = { stack: err.stack };
  }

  console.error('[ERROR]', JSON.stringify({
    requestId: req?.requestId || null,
    method: req?.method,
    path: req?.path || null,
    status,
    message: safeMessage,
    code: err.code || null,
  }));

  res.status(status).json(response);
}

module.exports = errorHandler;
