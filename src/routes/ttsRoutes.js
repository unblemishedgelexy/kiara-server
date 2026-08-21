const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const {
  streamElevenLabsSpeech,
} = require('../services/live/elevenLabsService');

const router = express.Router();

router.post('/preview', authMiddleware, async (req, res) => {
  const text = String(
    req.body?.text || ''
  ).trim();

  if (!text) {
    res.status(400).json({
      error: 'Text is required.',
    });
    return;
  }

  try {
    const response = await streamElevenLabsSpeech(text);

    if (!response) {
      res.status(204).end();
      return;
    }

    if (!response.ok) {
      res.status(response.status || 502).end();
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
  } catch {
    if (!res.headersSent) {
      res.status(502).end();
    }
  }
});

module.exports = router;
