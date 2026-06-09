const { env } = require('../config/env');
const { createLiveEphemeralToken } = require('./liveTokenService');

let state = {
  available: false,
  lastChecked: null,
  lastError: null,
};

async function checkOnce() {
  state.lastChecked = new Date();

  if (!env.geminiApiKey) {
    state.available = false;
    state.lastError = 'GEMINI_API_KEY not configured';
    return state;
  }

  try {
    // Try to create a token to confirm backend can reach Gemini service
    // Use null userId for health checks (no authenticated user)
    const token = await createLiveEphemeralToken(null);
    if (token && token.token) {
      state.available = true;
      state.lastError = null;
    } else {
      state.available = false;
      state.lastError = 'Invalid token response';
    }
  } catch (err) {
    state.available = false;
    state.lastError = err instanceof Error ? err.message : String(err);
  }

  state.lastChecked = new Date();
  return state;
}

let pollInterval = null;
function startPoll(intervalMs = 60 * 1000) {
  // run an immediate check
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
