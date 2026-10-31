const { env } = require('../../config/env');

let state = {
  available: false,
  lastChecked: null,
  lastError: null,
};

async function checkOnce() {
  state.lastChecked = new Date();
  if (env.liveGatewayUrl) {
    if (!env.liveGatewayHmacSecret) {
      state.available = false;
      state.lastError = 'gateway_auth_not_configured';
      return state;
    }

    try {
      const gatewayUrl = new URL('/healthz', env.liveGatewayUrl);
      if (process.env.NODE_ENV === 'production' && gatewayUrl.protocol !== 'https:') {
        state.available = false;
        state.lastError = 'gateway_https_required';
        return state;
      }

      const response = await fetch(gatewayUrl, { signal: AbortSignal.timeout(2000) });
      state.available = response.ok;
      state.lastError = response.ok ? null : 'gateway_unavailable';
      return state;
    } catch {
      state.available = false;
      state.lastError = 'gateway_unavailable';
      return state;
    }
  }

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
