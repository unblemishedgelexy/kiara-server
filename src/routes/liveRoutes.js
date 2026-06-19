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
  const requestMeta = {
    path: req.originalUrl,
    method: req.method,
    userId: req.userId || null,
    timestamp: new Date().toISOString(),
  };
  
  if (!env.geminiApiKey) {
    console.warn('[LiveRoute] missing Gemini API key', requestMeta);
    res.status(503).json({ error: 'Gemini API key is not configured.' });
    return;
  }

  try {
    const userId = req.userId || null;
    const token = await createLiveEphemeralToken(userId);

    if (!token || typeof token.token !== 'string' || !token.token.trim()) {
      console.error('[LiveRoute] invalid live token payload', { requestMeta, token });
      res.status(502).json({ error: 'Live token generation returned invalid token data.' });
      return;
    }

    const payload = {
      token: token.token,
      expireTime: token.expireTime,
      newSessionExpireTime: token.newSessionExpireTime,
      sessionConfig: token.sessionConfig,
    };

   
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

    console.error('[LiveRoute] failed to create live token', {
      ...requestMeta,
      error: errorMessage,
      statusCode,
    });
    res.status(statusCode).json(responseBody);
  }
});

module.exports = router;
