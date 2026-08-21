const express = require('express');
const { createLiveEphemeralToken } = require('../services/../services/live/liveTokenService');
const { env } = require('../config/env');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();
const geminiHealth = require('../services/../services/live/geminiHealth');

router.get('/health', async (_req, res) => {
  const health = geminiHealth.getStatus();
  res.json({
    elevenLabsConfigured: Boolean(env.elevenLabsApiKey && env.elevenLabsVoiceId),
    geminiConfigured: Boolean(env.geminiApiKey),
    geminiAvailable: Boolean(health.available),
    geminiLastError: health.lastError,
    ok: Boolean(env.geminiApiKey) && Boolean(health.available),
  });
});

router.post('/health/check', async (_req, res) => {
  try {
    const result = await geminiHealth.checkOnce();
    res.json({ success: true, status: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/token', authMiddleware.optional, async (req, res) => {
  if (!env.geminiApiKey) {
    res.status(503).json({ error: 'Gemini API key is not configured.' });
    return;
  }

  const requestStartedAt = Date.now();
  const userId = req.userId || null;
  const requestBody = req.body || {};
  const userQuery = typeof requestBody.userQuery === 'string' ? requestBody.userQuery : '';
  const sessionId = typeof requestBody.sessionId === 'string' ? requestBody.sessionId : userId || 'anonymous';
  const activeContext = requestBody.activeContext && typeof requestBody.activeContext === 'object' ? requestBody.activeContext : {};

  console.info('[LIVE_TOKEN_ROUTE]', {
    userId: userId || 'anonymous',
    sessionId,
    question: String(userQuery || '').slice(0, 180),
    method: req.method,
    path: req.path,
    timestamp: new Date().toISOString(),
  });

  try {
    const token = await createLiveEphemeralToken(userId, { userQuery, sessionId, activeContext });

    if (!token || typeof token.token !== 'string' || !token.token.trim()) {
      console.error('[ERROR]', 'Live token generation returned invalid token data.');
      res.status(502).json({ error: 'Live token generation returned invalid token data.' });
      return;
    }

    const payload = {
      token: token.token,
      expireTime: token.expireTime,
      newSessionExpireTime: token.newSessionExpireTime,
      sessionConfig: token.sessionConfig,
    };

    console.info('[LIVE_TOKEN_ROUTE_RESPONSE]', {
      userId: userId || 'anonymous',
      durationMs: Date.now() - requestStartedAt,
      sessionConfigModel: token.sessionConfig?.model || 'unknown',
      responseModalities: token.sessionConfig?.responseModalities || 'unknown',
      timestamp: new Date().toISOString(),
    });
    res.status(200).json(payload);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const normalizedMessage = errorMessage.toLowerCase();
    const responseBody = { error: errorMessage };
    let statusCode = 500;

    if (normalizedMessage.includes('gemini api key')) {
      statusCode = 503;
      responseBody.reason = 'gemini_not_configured';
    } else if (normalizedMessage.includes('failed to create gemini live ephemeral token')) {
      statusCode = 502;
      responseBody.reason = 'token_generation_failed';
    }

    console.error('[ERROR]', 'Failed to create live token:', errorMessage);
    res.status(statusCode).json(responseBody);
  }
});

module.exports = router;
