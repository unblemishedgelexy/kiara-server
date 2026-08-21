const { env } = require('../../config/env');

let state = {
  available: false,
  lastChecked: null,
  lastError: null,
};

async function checkOnce() {
  state.lastChecked = new Date();
  state.available = Boolean(env.geminiApiKey);
  state.lastError = state.available ? null : 'GEMINI_API_KEY not configured';
  return state;
}

let pollInterval = null;
function startPoll(intervalMs = 60 * 1000) {
  void checkOnce().catch(() => undefined);
  if (pollInterval) return;
  pollInterval = setInterval(() => {
    void checkOnce().catch(() => undefined);
  }, intervalMs);
}

function stopPoll() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function getStatus() {
  return { ...state };
}

module.exports = { checkOnce, startPoll, stopPoll, getStatus };
