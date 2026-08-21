const express = require('express');
const router = express.Router();
const perf = require('../middleware/perfCollector');

router.get('/perf', (_req, res) => {
  res.json(perf.getSummary());
});

router.post('/perf/record', (req, res) => {
  const { type, name, duration, meta } = req.body || {};
  try {
    if (type === 'stage') perf.record(name, Number(duration) || 0, meta);
    if (type === 'gemini') perf.recordGemini(meta || {});
    if (type === 'redis') perf.recordRedis(meta || {});
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e) });
  }
});

module.exports = router;
