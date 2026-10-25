const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const redisAbuseProtection = require('../middleware/redisAbuseProtection');
const {
  streamElevenLabsSpeech,
} = require('../services/live/elevenLabsService');

const router = express.Router();

router.post('/preview', authMiddleware, redisAbuseProtection({ scope: 'account-ip', bucket: 'expensive' }), async (req, res) => {
  const text = String(
    req.body?.text || ''
  ).trim();

  if (!text || text.length > 1200) {
    res.status(400).json({
      error: text ? 'Text is too long for realtime TTS.' : 'Text is required.',
    });
    return;
  }

  const upstreamController = new AbortController();
  const upstreamTimeout = setTimeout(() => upstreamController.abort(), 30000);
  const abortIfClientClosed = () => {
    if (!res.writableEnded) upstreamController.abort();
  };
  res.once('close', abortIfClientClosed);
  try {
    const response = await streamElevenLabsSpeech(text, { signal: upstreamController.signal });

    if (!response) {
      res.status(204).end();
      return;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      res.status(502).json({ success: false, message: 'Speech service is temporarily unavailable.' });
      return;
    }

    if (!response.body) {
      res.status(502).end();
      return;
    }

    res.setHeader(
      'Content-Type',
      response.headers.get('content-type') ||
        'audio/mpeg'
    );

    res.setHeader(
      'Cache-Control',
      'no-store'
    );

    for await (const chunk of response.body) {
      res.write(Buffer.from(chunk));
    }

    res.end();
  } catch (error) {
    console.error('[TTS_PREVIEW_FAILED]', error?.name || error?.code || 'ProviderError');
    if (!res.headersSent) {
      res.status(502).end();
    }
  } finally {
    clearTimeout(upstreamTimeout);
    res.removeListener('close', abortIfClientClosed);
  }
});

module.exports = router;
