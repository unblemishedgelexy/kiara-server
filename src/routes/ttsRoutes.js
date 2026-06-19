const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { streamElevenLabsSpeech } = require('../services/../services/live/elevenLabsService');

const router = express.Router();

router.post('/preview', authMiddleware, async (req, res) => {
  const text = String(req.body && req.body.text ? req.body.text : '').trim();
  if (!text) {
    res.status(400).json({ error: 'Text is required.' });
    return;
  }

  try {
    const response = await streamElevenLabsSpeech(text);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');

    if (!response.body) {
      res.status(502).end();
      return;
    }

    for await (const chunk of response.body) {
      res.write(Buffer.from(chunk));
    }

    res.end();
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'TTS preview failed.',
    });
  }
});

module.exports = router;
