const express = require('express');
const { createLiveEphemeralToken } = require('../services/../services/live/liveTokenService');
const { env } = require('../config/env');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();
const geminiHealth = require('../services/../services/live/geminiHealth');

router.get('/health', async (_req, res) => {
  const health = await geminiHealth.checkOnce();
  const geminiConfigured = Boolean(env.geminiApiKey);
  const geminiAvailable = Boolean(health.available);
  const offlineMode = !geminiConfigured || !geminiAvailable;

  res.json({
    elevenLabsConfigured: Boolean(env.elevenLabsApiKey && env.elevenLabsVoiceId),
    geminiConfigured,
    geminiAvailable,
    geminiLastError: health.lastError,
    offlineMode,
    ok: true,
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
  const requestStartedAt = performance.now ? performance.now() : Date.now();
  const traceId = req.headers['x-kiara-trace-id'] || req.headers['X-Kiara-Trace-Id'] || `live-token-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (process.env.NODE_ENV === 'development' || process.env.KIARA_LATENCY_DEBUG === 'true') {
    console.info('[KIARA_LATENCY_BACKEND]', JSON.stringify({ traceId, route: '/api/live/token', stage: 'request_received', ms: Math.round(requestStartedAt) }));
  }

  if (!env.geminiApiKey) {
    res.status(200).json({
      offlineMode: true,
      mode: 'offline',
      message: 'Kiara is running in offline mode and cannot create a live Gemini token right now.',
      token: null,
      expireTime: null,
      newSessionExpireTime: null,
      sessionConfig: null,
    });
    return;
  }

  const userId = req.userId || null;
  const requestBody = req.body || {};
  const userQuery = typeof requestBody.userQuery === 'string' ? requestBody.userQuery : '';
  const sessionId = typeof requestBody.sessionId === 'string' ? requestBody.sessionId : userId || 'anonymous';
  const activeContext = requestBody.activeContext && typeof requestBody.activeContext === 'object' ? requestBody.activeContext : {};
  console.info('[KIARA_LIVE_SESSION_START]', JSON.stringify({
    traceId,
    userId,
    sessionId,
    lifecycleTrigger: req.lifecycleTrigger || 'LIVE_SESSION_START',
    authHeaderPresent: Boolean(req.headers.authorization || req.headers['x-access-token']),
    hasUserQuery: Boolean(userQuery),
    userQueryLength: userQuery.length,
    at: new Date().toISOString(),
  }));
  try {
    const authCompletedAt = performance.now ? performance.now() : Date.now();
    if (process.env.NODE_ENV === 'development' || process.env.KIARA_LATENCY_DEBUG === 'true') {
      console.info('[KIARA_LATENCY_BACKEND]', JSON.stringify({ traceId, route: '/api/live/token', stage: 'auth_complete', ms: Math.round(authCompletedAt - requestStartedAt) }));
    }

    const token = await createLiveEphemeralToken(userId, { userQuery, sessionId, activeContext, lifecycleTrigger: req.lifecycleTrigger || 'LIVE_SESSION_START', traceId });

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

    if (process.env.NODE_ENV === 'development' || process.env.KIARA_LATENCY_DEBUG === 'true') {
      console.info('[KIARA_LATENCY_BACKEND]', JSON.stringify({ traceId, route: '/api/live/token', stage: 'response_sent', ms: Math.round((performance.now ? performance.now() : Date.now()) - requestStartedAt) }));
    }

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
