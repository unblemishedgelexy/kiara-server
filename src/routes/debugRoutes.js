const express = require('express');
const router = express.Router();
const runtimeSupervisor = require('../services/runtimeSupervisor');

router.post('/sync-time', express.json(), (req, res) => {
  try {
    const { requestId, clientTimestamp, timezone, promptTimestamp } = req.body || {};
    const result = runtimeSupervisor.acceptTimeSync({ requestId, clientTimestamp, timezone, promptTimestamp });
    res.json({ success: true, result });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

router.post('/gemini-log', express.json(), (req, res) => {
  try {
    const { requestId, promptTimestamp, clientTimestamp, timezone } = req.body || {};
    const entry = runtimeSupervisor.recordGeminiRequest({ requestId, promptTimestamp, clientTimestamp, timezone });
    res.json({ success: true, entry });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

router.post('/runtime-context', express.json(), (req, res) => {
  try {
    const context = req.body || {};
    const result = runtimeSupervisor.acceptRuntimeContext(context);
    res.json({ success: result.ok === true, result });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

router.post('/heartbeat', express.json(), (req, res) => {
  try {
    const hb = req.body || {};
    const result = runtimeSupervisor.acceptHeartbeat(hb);
    res.json({ success: result.ok === true, result });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

router.get('/runtime', (_req, res) => {
  try {
    const report = runtimeSupervisor.getReport();
    res.json({ success: true, report });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

router.get('/runtime-report', (_req, res) => {
  try {
    const report = runtimeSupervisor.getReport();
    // Provide a more detailed structure for diagnostics
    res.json({ success: true, detailed: report });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

module.exports = router;
