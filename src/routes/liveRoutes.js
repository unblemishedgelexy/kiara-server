const express = require('express');
const { createLiveEphemeralToken } = require('../services/liveTokenService');
const { env } = require('../config/env');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();
const geminiHealth = require('../services/geminiHealth');

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
    res.status(503).json({ error: 'Gemini server key is missing.' });
    return;
  }

  try {
    const userId = req.userId || null;
    const token = await createLiveEphemeralToken(userId);
    res.json({
      expireTime: token.expireTime,
      newSessionExpireTime: token.newSessionExpireTime,
      token: token.token,
      sessionConfig: token.sessionConfig,
    });
  } catch (error) {
    console.error('Failed to create live token:', error);
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Live token request failed.',
    });
  }
});

module.exports = router;
