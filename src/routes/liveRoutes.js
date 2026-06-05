const express = require('express');
const { createLiveEphemeralToken } = require('../services/liveTokenService');
const { env } = require('../config/env');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/health', (_req, res) => {
  res.json({
    elevenLabsConfigured: Boolean(env.elevenLabsApiKey && env.elevenLabsVoiceId),
    geminiConfigured: Boolean(env.geminiApiKey),
    ok: Boolean(env.geminiApiKey),
  });
});

router.post('/token', authMiddleware, async (_req, res) => {
  if (!env.geminiApiKey) {
    res.status(503).json({ error: 'Gemini server key is missing.' });
    return;
  }

  try {
    const token = await createLiveEphemeralToken();
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
