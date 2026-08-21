'use strict';

const STABILITY_WINDOW_MS = 15 * 60 * 1000;
const gateBySession = new Map();
let lastGateLog = null;

function getSessionKey(userId, sessionId) {
  return `${userId || 'anonymous'}:${sessionId || 'anonymous-session'}`;
}

function logGateChange(message) {
  if (lastGateLog === message) {
    return;
  }
  lastGateLog = message;
  console.info('[LIVE-STABILITY]', message);
}

function setMemoryEligibility({ userId, sessionId, eligible = false, reason = 'manual', enabledAt = Date.now() } = {}) {
  const key = getSessionKey(userId, sessionId);

  if (!eligible) {
    gateBySession.set(key, {
      userId: userId || 'anonymous',
      sessionId: sessionId || 'anonymous-session',
      eligible: false,
      reason,
      enabledAt: null,
      startedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
    });
    logGateChange(`Session became unhealthy — memory eligibility reset (${reason})`);
    return { eligible: false, reason };
  }

  gateBySession.set(key, {
    userId: userId || 'anonymous',
    sessionId: sessionId || 'anonymous-session',
    eligible: true,
    reason,
    enabledAt,
    startedAt: Date.now(),
    lastHeartbeatAt: Date.now(),
  });

  logGateChange(`Session healthy — memory eligibility enabled (${reason})`);
  return { eligible: true, reason, enabledAt };
}

function isMemoryEligible(userId, sessionId) {
  if (!userId || !sessionId) return false;

  const key = getSessionKey(userId, sessionId);
  const state = gateBySession.get(key);

  if (!state) {
    return true;
  }

  if (state.eligible === false) {
    return false;
  }

  if (state.eligible) {
    return true;
  }

  const now = Date.now();
  const stableDurationMs = state.startedAt ? now - state.startedAt : 0;
  if (stableDurationMs >= STABILITY_WINDOW_MS) {
    setMemoryEligibility({
      userId,
      sessionId,
      eligible: true,
      reason: 'live_session_stable_15_minutes',
      enabledAt: state.startedAt || now,
    });
    return true;
  }

  return false;
}

function clearSession(userId, sessionId) {
  const key = getSessionKey(userId, sessionId);
  if (gateBySession.has(key)) {
    gateBySession.delete(key);
    logGateChange('Session cleanup — memory eligibility reset');
  }
}

function getStatus(userId, sessionId) {
  const key = getSessionKey(userId, sessionId);
  const state = gateBySession.get(key);
  if (!state) {
    return {
      memoryEligible: Boolean(userId && sessionId),
      reason: userId && sessionId ? 'memory_eligible_by_default' : 'missing_session_identity',
      enabledAt: null,
    };
  }

  return {
    memoryEligible: Boolean(state.eligible),
    reason: state.reason,
    enabledAt: state.enabledAt,
  };
}

function markLiveSessionHealth({ userId, sessionId, connected = false, audioReady = false, healthy = false, timestamp = Date.now() } = {}) {
  if (!userId || !sessionId) {
    return { eligible: false, reason: 'missing_session_identity' };
  }

  const key = getSessionKey(userId, sessionId);
  const current = gateBySession.get(key) || {
    userId,
    sessionId,
    eligible: false,
    reason: 'memory_disabled_until_stability_gate',
    enabledAt: null,
    startedAt: timestamp,
    lastHeartbeatAt: timestamp,
  };

  if (!current.startedAt) {
    current.startedAt = timestamp;
  }

  const isHealthyEnough = Boolean(connected && audioReady && healthy);
  current.lastHeartbeatAt = timestamp;

  if (!isHealthyEnough) {
    if (current.eligible) {
      setMemoryEligibility({ userId, sessionId, eligible: false, reason: 'live_session_unhealthy' });
    }
    return { eligible: false, reason: 'live_session_unhealthy' };
  }

  const stableDurationMs = timestamp - current.startedAt;
  if (!current.eligible) {
    setMemoryEligibility({
      userId,
      sessionId,
      eligible: true,
      reason: 'live_session_healthy',
      enabledAt: current.startedAt,
    });
  } else {
    gateBySession.set(key, {
      ...current,
      eligible: true,
      reason: current.reason || 'live_session_healthy',
      enabledAt: current.enabledAt || current.startedAt,
    });
  }

  return { eligible: true, reason: 'live_session_healthy', stableMs: stableDurationMs };
}

module.exports = {
  STABILITY_WINDOW_MS,
  setMemoryEligibility,
  isMemoryEligible,
  clearSession,
  getStatus,
  markLiveSessionHealth,
};
