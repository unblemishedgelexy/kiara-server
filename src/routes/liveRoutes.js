const express = require('express');

const {
  createLiveEphemeralToken,
} = require('../services/../services/live/liveTokenService');

const {
  streamElevenLabsSpeech,
} = require('../services/../services/live/elevenLabsService');

const { env } = require('../config/env');
const authMiddleware = require('../middleware/authMiddleware');
const subscriptionUsageService = require('../services/subscriptions/usageService');

const router = express.Router();

const geminiHealth = require('../services/../services/live/geminiHealth');

/**
 * ============================================================
 * LIVE HEALTH
 * ============================================================
 */
router.get('/health', async (_req, res) => {
  try {
    const health = await geminiHealth.checkOnce();

    const geminiConfigured = Boolean(env.geminiApiKey);
    const geminiAvailable = Boolean(health.available);
    const elevenLabsConfigured = Boolean(
      env.elevenLabsApiKey && env.elevenLabsVoiceId
    );

    const offlineMode = !geminiConfigured || !geminiAvailable;

    res.json({
      elevenLabsConfigured,
      geminiConfigured,
      geminiAvailable,
      geminiLastError: health.lastError,
      offlineMode,
      ok: true,
    });
  } catch (error) {
    console.error('[ERROR] Live health check failed:', error);

    res.status(500).json({
      elevenLabsConfigured: Boolean(
        env.elevenLabsApiKey && env.elevenLabsVoiceId
      ),
      geminiConfigured: Boolean(env.geminiApiKey),
      geminiAvailable: false,
      geminiLastError:
        error instanceof Error ? error.message : String(error),
      offlineMode: true,
      ok: false,
    });
  }
});

/**
 * ============================================================
 * GEMINI HEALTH CHECK
 * ============================================================
 */
router.post('/health/check', async (_req, res) => {
  try {
    const result = await geminiHealth.checkOnce();

    res.json({
      success: true,
      status: result,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * ============================================================
 * ELEVENLABS TTS
 * ============================================================
 *
 * Frontend:
 *
 * POST /api/live/tts
 * {
 *   "text": "Hello, how are you?"
 * }
 *
 * Backend:
 *
 * Frontend → this route → ElevenLabs → audio/mpeg stream
 *
 * Gemini Live token route remains completely separate.
 */
router.post('/tts', authMiddleware.optional, async (req, res) => {
  const traceId =
    req.headers['x-kiara-trace-id'] ||
    req.headers['X-Kiara-Trace-Id'] ||
    `tts-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

  try {
    /**
     * ----------------------------------------------------------
     * Validate ElevenLabs configuration
     * ----------------------------------------------------------
     */
    if (!env.elevenLabsApiKey || !env.elevenLabsVoiceId) {
      console.warn(
        '[KIARA_TTS] ElevenLabs is not configured',
        JSON.stringify({
          traceId,
          hasApiKey: Boolean(env.elevenLabsApiKey),
          hasVoiceId: Boolean(env.elevenLabsVoiceId),
        })
      );

      res.status(503).json({
        error: 'ElevenLabs TTS is not configured.',
        reason: 'elevenlabs_not_configured',
      });

      return;
    }

    /**
     * ----------------------------------------------------------
     * Read request body
     * ----------------------------------------------------------
     */
    const requestBody = req.body || {};

    const text =
      typeof requestBody.text === 'string'
        ? requestBody.text.trim()
        : '';

    /**
     * ----------------------------------------------------------
     * Validate text
     * ----------------------------------------------------------
     */
    if (!text) {
      res.status(400).json({
        error: 'Text is required for ElevenLabs TTS.',
        reason: 'missing_text',
      });

      return;
    }

    /**
     * Prevent accidentally sending extremely large text blocks
     * to the TTS service.
     *
     * Kiara LIVE responses are intentionally short, so this keeps
     * the TTS path lightweight.
     */
    const MAX_TTS_TEXT_LENGTH = 1200;

    if (text.length > MAX_TTS_TEXT_LENGTH) {
      res.status(400).json({
        error: `Text is too long for realtime TTS. Maximum length is ${MAX_TTS_TEXT_LENGTH} characters.`,
        reason: 'text_too_long',
      });

      return;
    }

    const userId = req.userId || null;

    /**
     * ----------------------------------------------------------
     * Call existing ElevenLabs service
     * ----------------------------------------------------------
     */
    const elevenLabsResponse = await streamElevenLabsSpeech(text);

    if (!elevenLabsResponse) {
      res.status(503).json({
        error: 'ElevenLabs TTS is currently unavailable.',
        reason: 'elevenlabs_unavailable',
      });

      return;
    }

    /**
     * ----------------------------------------------------------
     * Check ElevenLabs response
     * ----------------------------------------------------------
     */
    if (!elevenLabsResponse.ok) {
      let providerError = '';

      try {
        providerError = await elevenLabsResponse.text();
      } catch {
        providerError = '';
      }

      console.error(
        '[KIARA_TTS] ElevenLabs request failed',
        JSON.stringify({
          traceId,
          status: elevenLabsResponse.status,
          statusText: elevenLabsResponse.statusText,
          providerError: providerError.slice(0, 1000),
        })
      );

      res.status(
        elevenLabsResponse.status >= 400 &&
          elevenLabsResponse.status < 500
          ? 502
          : 503
      ).json({
        error: 'ElevenLabs TTS request failed.',
        reason: 'elevenlabs_provider_error',
      });

      return;
    }

    /**
     * ----------------------------------------------------------
     * Stream audio directly to frontend
     * ----------------------------------------------------------
     *
     * ElevenLabs service returns audio/mpeg.
     *
     * We intentionally do NOT buffer the complete audio file here.
     * The response is streamed to the frontend.
     */
    res.status(200);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Kiara-Trace-Id', traceId);

    if (elevenLabsResponse.headers.has('content-length')) {
      res.setHeader(
        'Content-Length',
        elevenLabsResponse.headers.get('content-length')
      );
    }

    if (!elevenLabsResponse.body) {
      console.error(
        '[KIARA_TTS] ElevenLabs returned no response body',
        JSON.stringify({
          traceId,
        })
      );

      if (!res.headersSent) {
        res.status(502).json({
          error: 'ElevenLabs returned an empty audio response.',
          reason: 'empty_audio_response',
        });
      }

      return;
    }

    /**
     * ----------------------------------------------------------
     * Node fetch ReadableStream → Express response
     * ----------------------------------------------------------
     */
    try {
      const reader = elevenLabsResponse.body.getReader();

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        if (value) {
          res.write(Buffer.from(value));
        }
      }

      res.end();
    } catch (streamError) {
      console.error(
        '[KIARA_TTS] Audio streaming failed',
        JSON.stringify({
          traceId,
          error:
            streamError instanceof Error
              ? streamError.message
              : String(streamError),
        })
      );

      if (!res.writableEnded) {
        res.end();
      }

      return;
    }

    /**
     * ----------------------------------------------------------
     * Latency logging
     * ----------------------------------------------------------
     */
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    console.error(
      '[KIARA_TTS] Failed to generate ElevenLabs speech',
      JSON.stringify({
        traceId,
        error: errorMessage,
      })
    );

    /**
     * If the response has already started streaming, we cannot safely
     * replace it with a JSON error response.
     */
    if (res.headersSent || res.writableEnded) {
      if (!res.writableEnded) {
        res.end();
      }

      return;
    }

    res.status(500).json({
      error: 'Failed to generate ElevenLabs speech.',
      reason: 'tts_generation_failed',
    });
  }
});

/**
 * ============================================================
 * GEMINI LIVE EPHEMERAL TOKEN
 * ============================================================
 *
 * IMPORTANT:
 * ElevenLabs TTS is intentionally NOT mixed into this route.
 */
router.post('/token', authMiddleware, async (req, res) => {
  const traceId =
    req.headers['x-kiara-trace-id'] ||
    req.headers['X-Kiara-Trace-Id'] ||
    `live-token-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

  if (!env.geminiApiKey) {
    res.status(200).json({
      offlineMode: true,
      mode: 'offline',
      message:
        'Kiara is running in offline mode and cannot create a live Gemini token right now.',
      token: null,
      expireTime: null,
      newSessionExpireTime: null,
      sessionConfig: null,
    });

    return;
  }

  const userId = req.userId || null;
  const requestBody = req.body || {};

  const userQuery =
    typeof requestBody.userQuery === 'string'
      ? requestBody.userQuery
      : '';

  const sessionId =
    typeof requestBody.sessionId === 'string'
      ? requestBody.sessionId
      : userId || 'anonymous';

  const activeContext =
    requestBody.activeContext &&
    typeof requestBody.activeContext === 'object'
      ? requestBody.activeContext
      : {};

  let meteringSessionId = null;
  let createdMeteringSession = false;
  if (userId) {
    try {
      const meter = await subscriptionUsageService.startLiveSession(
        userId,
        req.lifecycleTrigger || 'LIVE_SESSION_START',
      );
      meteringSessionId = meter.sessionId;
      createdMeteringSession = meter.created;
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 503;
      return res.status(statusCode).json({
        success: false,
        code: error?.code || 'LIVE_USAGE_UNAVAILABLE',
        error: error instanceof Error ? error.message : 'Unable to start the live session.',
        ...(error?.details ? { details: error.details } : {}),
      });
    }
  }

  try {
    const token = await createLiveEphemeralToken(userId, {
      userQuery,
      sessionId,
      activeContext,
      lifecycleTrigger:
        req.lifecycleTrigger || 'LIVE_SESSION_START',
      traceId,
    });

    if (
      !token ||
      typeof token.token !== 'string' ||
      !token.token.trim()
    ) {
      console.error(
        '[ERROR]',
        'Live token generation returned invalid token data.'
      );

      if (userId && createdMeteringSession && meteringSessionId) {
        await subscriptionUsageService.abortLiveSession(userId, meteringSessionId).catch(() => undefined);
      }

      res.status(502).json({
        error:
          'Live token generation returned invalid token data.',
      });

      return;
    }

    const payload = {
      token: token.token,
      expireTime: token.expireTime,
      newSessionExpireTime:
        token.newSessionExpireTime,
      sessionConfig: token.sessionConfig,
      ...(meteringSessionId ? { meteringSessionId } : {}),
    };


    res.status(200).json(payload);
  } catch (error) {
    if (userId && createdMeteringSession && meteringSessionId) {
      await subscriptionUsageService.abortLiveSession(userId, meteringSessionId).catch(() => undefined);
    }
    const errorMessage =
      error instanceof Error
        ? error.message
        : String(error);

    const normalizedMessage =
      errorMessage.toLowerCase();

    const responseBody = {
      success: false,
      code: error?.code || 'LIVE_TOKEN_FAILED',
      error: errorMessage,
      ...(error?.details ? { details: error.details } : {}),
    };

    let statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;

    if (
      normalizedMessage.includes('gemini api key')
    ) {
      statusCode = 503;
      responseBody.reason = 'gemini_not_configured';
    } else if (
      normalizedMessage.includes(
        'failed to create gemini live ephemeral token'
      )
    ) {
      statusCode = 502;
      responseBody.reason =
        'token_generation_failed';
    }

    console.error(
      '[ERROR]',
      'Failed to create live token:',
      errorMessage
    );

    res.status(statusCode).json(responseBody);
  }
});

module.exports = router;