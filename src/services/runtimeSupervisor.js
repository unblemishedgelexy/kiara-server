/** Server-side Runtime Supervisor
 * - Lightweight in-memory event recorder
 * - Exposes a simple API other services can call to record events and report status
 */
const DEFAULT_MAX_EVENTS = 500;

class ServerRuntimeSupervisor {
  constructor() {
    this.events = [];
    this.maxEvents = DEFAULT_MAX_EVENTS;
    this.subsystems = {};
    this.lastClientTime = null;
    this.lastTimeSync = null;
    this.timezone = null;
    this.clockDriftMs = null;
    this.lastPromptTimestamp = null;
    this.geminiRequests = [];
    this.lastRuntimeContext = null;
    this.lastRuntimeContextTs = null;
    this.heartbeats = [];
    this.lastHeartbeat = null;
    this.currentHeartbeat = null;
    this.heartbeatMissCount = 0;
    this.restartCounts = {};
    this.recoveryCount = 0;
    this.warningCounters = {};
    this.lastHealthSummary = null;
    this.lastRuntimeMode = 'HEALTHY';
    this.lastRecoveryMetrics = null;
    this.runtimeStartTs = Date.now();
    this.runtimeVersion = process.env.npm_package_version || 'unknown';
    this.buildNumber = process.env.BUILD_NUMBER || null;
    this.inspectorLastSummaryTs = 0;
    this.inspectorLastDetailedTs = 0;
    this.backgroundChecksStarted = false;
  }

  recordEvent(type, level = 'info', msg = '', data = null) {
    const ev = { ts: Date.now(), type, level, msg, data };
    this.events.push(ev);
    if (this.events.length > this.maxEvents) this.events.shift();
  }

  registerSubsystem(name, state = 'IDLE') {
    this.subsystems[name] = this.subsystems[name] || { name, state, lastHeartbeat: 0, heartbeatAgeMs: Infinity };
  }

  heartbeat(name, payload = {}) {
    this.registerSubsystem(name);
    this.subsystems[name].lastHeartbeat = Date.now();
    this.subsystems[name].heartbeatAgeMs = 0;
    this.subsystems[name].lastPayload = payload;
    this.subsystems[name].state = payload.state || this.subsystems[name].state;
    this.recordEvent('heartbeat', 'info', `heartbeat ${name}`, { name, payload });
  }

  acceptTimeSync({ requestId = null, clientTimestamp = null, timezone = null, promptTimestamp = null } = {}) {
    const serverTimestamp = Date.now();
    try {
      if (clientTimestamp == null) throw new Error('clientTimestamp missing');
      const drift = serverTimestamp - clientTimestamp;
      this.lastClientTime = clientTimestamp;
      this.lastTimeSync = serverTimestamp;
      this.timezone = timezone || this.timezone;
      this.clockDriftMs = drift;
      if (promptTimestamp) this.lastPromptTimestamp = promptTimestamp;
      this.recordEvent('clock_sync', Math.abs(drift) > 2000 ? 'warn' : 'info', 'time sync', { requestId, clientTimestamp, serverTimestamp, timezone, drift });
      if (Math.abs(drift) > 2000) {
        this.recordEvent('CLOCK_SYNC_WARNING', 'warn', 'Clock drift exceeds 2s', { drift, requestId });
      }
      return { serverTimestamp, drift };
    } catch (e) {
      this.recordEvent('CLOCK_SYNC_ERROR', 'error', 'Failed to read client time', { error: String(e), requestId });
      return { serverTimestamp, error: String(e) };
    }
  }

  recordGeminiRequest({ requestId, promptTimestamp, clientTimestamp, timezone } = {}) {
    const serverTimestamp = Date.now();
    const drift = clientTimestamp != null ? serverTimestamp - clientTimestamp : null;
    const entry = { ts: serverTimestamp, requestId, promptTimestamp, clientTimestamp, timezone, serverTimestamp, clockDrift: drift };
    this.geminiRequests.push(entry);
    if (this.geminiRequests.length > this.maxEvents) this.geminiRequests.shift();
    this.recordEvent('gemini_request', 'info', 'gemini request logged', entry);
    if (drift != null && Math.abs(drift) > 2000) {
      this.recordEvent('CLOCK_SYNC_WARNING', 'warn', 'Clock drift exceeds 2s on gemini request', { requestId, drift });
    }
    return entry;
  }

  acceptRuntimeContext(context = {}) {
    const serverTs = Date.now();
    try {
      const { runtimeContextGeneratedAt, currentClientTime } = context;
      if (!runtimeContextGeneratedAt || !currentClientTime) {
        this.recordEvent('RUNTIME_CONTEXT_BUILD_FAILED', 'error', 'Missing required runtime context fields', { context });
        return { ok: false, error: 'missing_fields' };
      }

      const ageMs = serverTs - runtimeContextGeneratedAt;
      // Detect reuse of same runtime context
      if (this.lastRuntimeContextTs && runtimeContextGeneratedAt === this.lastRuntimeContextTs) {
        this.recordEvent('RUNTIME_CACHE_WARNING', 'warn', 'Runtime context appears reused (same generatedAt)', { runtimeContextGeneratedAt, ageMs });
      }

      if (ageMs > 3000) {
        this.recordEvent('STALE_RUNTIME_DATA', 'warn', 'Runtime context older than 3s', { ageMs });
      }

      this.lastRuntimeContext = context;
      this.lastRuntimeContextTs = runtimeContextGeneratedAt;
      this.recordEvent('runtime_context', 'info', 'Runtime context accepted', { ageMs, context });
      return { ok: true, serverTimestamp: serverTs, ageMs };
    } catch (e) {
      this.recordEvent('RUNTIME_REFRESH_FAILED', 'error', 'Failed during runtime context validation', { error: String(e), context });
      return { ok: false, error: String(e) };
    }
  }

  acceptHeartbeat(hb = {}) {
    const serverTs = Date.now();
    try {
      const runtimeTimestamp = hb.runtimeTimestamp || hb.runtimeTime || hb.runtimeContextGeneratedAt || hb.clientTimestamp || null;
      const clientTimestamp = hb.clientTimestamp || null;
      const requestId = hb.requestId || null;

      const entry = { ts: serverTs, receivedAt: serverTs, requestId, runtimeTimestamp, clientTimestamp, payload: hb };
      this.heartbeats.push(entry);
      if (this.heartbeats.length > this.maxEvents) this.heartbeats.shift();

      this.lastHeartbeat = this.currentHeartbeat || null;
      this.currentHeartbeat = entry;
      if (hb.healthSummary) {
        this.lastHealthSummary = hb.healthSummary;
      }
      if (hb.runtimeMode) {
        this.lastRuntimeMode = hb.runtimeMode;
      }
      if (hb.recoveryMetrics) {
        this.lastRecoveryMetrics = hb.recoveryMetrics;
      }

      // heartbeat age / delay metrics
      const heartbeatDelay = runtimeTimestamp ? serverTs - runtimeTimestamp : null;
      if (heartbeatDelay != null && heartbeatDelay > 30000) {
        this.recordEvent('HEARTBEAT_MISSED', 'warn', 'Heartbeat gap >30s', { requestId, heartbeatDelay });
        this.heartbeatMissCount += 1;
      }

      // check for restart hints
      if (hb.restarts && typeof hb.restarts === 'object') {
        for (const [k, v] of Object.entries(hb.restarts)) {
          this.restartCounts[k] = (this.restartCounts[k] || 0) + Number(v || 0);
        }
      }

      if (hb.runtimeRecovery) {
        this.recoveryCount += 1;
        this.recordEvent('RUNTIME_RECOVERY', 'info', 'Client requested runtime recovery', { requestId });
      }

      // increment warning counters if events included
      if (hb.warnings && Array.isArray(hb.warnings)) {
        hb.warnings.forEach((w) => { this.warningCounters[w] = (this.warningCounters[w] || 0) + 1; });
      }

      this.recordEvent('heartbeat', 'info', 'heartbeat received', { requestId, heartbeatDelay });
      return { ok: true, serverTimestamp, heartbeatDelay };
    } catch (e) {
      this.recordEvent('HEARTBEAT_ERROR', 'error', 'Failed to accept heartbeat', { error: String(e), hb });
      return { ok: false, error: String(e) };
    }
  }

  startBackgroundChecks() {
    if (this.backgroundChecksStarted) return;
    this.backgroundChecksStarted = true;
    this._backgroundChecksHandle = setInterval(() => {
      try {
        const now = Date.now();
        const last = this.currentHeartbeat ? this.currentHeartbeat.receivedAt : null;
        const delta = last ? now - last : Infinity;
        if (delta > 30000 && delta <= 60000) {
          this.recordEvent('HEARTBEAT_MISSED', 'warn', 'No heartbeat >30s', { delta });
        }
        if (delta > 60000 && delta <= 90000) {
          this.recordEvent('RUNTIME_STALLED', 'warn', 'No heartbeat >60s', { delta });
        }
        if (delta > 90000) {
          this.recordEvent('RUNTIME_RECOVERY', 'error', 'No heartbeat >90s - escalation', { delta });
          this.recoveryCount += 1;
        }
      } catch (e) {
        this.recordEvent('INSPECTOR_ERROR', 'error', 'background check failed', { error: String(e) });
      }
    }, 15000);

    this._inspectorHandle = setInterval(() => {
      try {
        const now = Date.now();
        const snapshot = {
          ts: now,
          uptimeMs: now - this.runtimeStartTs,
          lastHeartbeatAgeMs: this.currentHeartbeat ? now - this.currentHeartbeat.receivedAt : null,
        };
        if (!this._lastInspectorSnapshot || JSON.stringify(this._lastInspectorSnapshot) !== JSON.stringify(snapshot)) {
          this._lastInspectorSnapshot = snapshot;
        }
        if (!this.inspectorLastDetailedTs || now - this.inspectorLastDetailedTs >= 30000) {
          const report = this.getReport();
          this.inspectorLastDetailedTs = now;
          if (report && report.events) {
            this.recordEvent('INSPECTOR_SUMMARY', 'info', 'Runtime inspector summary generated', { eventCount: report.events.length, heartbeatCount: this.heartbeats.length });
          }
        }
      } catch (e) {
        this.recordEvent('INSPECTOR_ERROR', 'error', 'inspector failed', { error: String(e) });
      }
    }, 5000);
  }

  stopBackgroundChecks() {
    if (this._backgroundChecksHandle) {
      clearInterval(this._backgroundChecksHandle);
      this._backgroundChecksHandle = null;
    }
    if (this._inspectorHandle) {
      clearInterval(this._inspectorHandle);
      this._inspectorHandle = null;
    }
    this.backgroundChecksStarted = false;
  }

  getReport() {
    const currentConnection = this.currentHeartbeat?.payload?.connectionState || null;
    const currentInternet = this.currentHeartbeat?.payload?.internetState ?? null;
    const currentSession = this.currentHeartbeat?.payload?.sessionState || null;
    const currentVoice = this.currentHeartbeat?.payload?.voiceState || null;
    const currentEmotion = this.currentHeartbeat?.payload?.emotionState || null;
    const currentListening = this.currentHeartbeat?.payload?.listeningState ?? null;
    const currentSpeaking = this.currentHeartbeat?.payload?.speakingState ?? null;
    const currentAvatar = this.currentHeartbeat?.payload?.avatarState || null;
    const currentDevice = this.currentHeartbeat?.payload?.deviceState || null;
    const currentBattery = this.currentHeartbeat?.payload?.battery || null;
    const activeRequest = this.currentHeartbeat?.requestId || null;
    const pendingRequests = this.currentHeartbeat?.payload?.pendingRequests ?? null;
    const currentAudioQueue = this.currentHeartbeat?.payload?.audioQueueLength ?? null;
    const lastRuntimeContext = this.lastRuntimeContext || null;
    const lastRuntimeContextAge = lastRuntimeContext && this.lastRuntimeContextTs ? Date.now() - this.lastRuntimeContextTs : null;
    const lastRuntimeContextBuildTime = lastRuntimeContext ? (lastRuntimeContext.runtimeContextGeneratedAt || null) : null;
    const lastRuntimeRefresh = this.lastHeartbeat ? this.lastHeartbeat.ts : null;
    const heartbeatHealthSummary = this.currentHeartbeat?.payload?.healthSummary || this.lastHealthSummary || null;
    const runtimeMode = this.currentHeartbeat?.payload?.runtimeMode || this.lastRuntimeMode;
    const recoveryMetrics = this.currentHeartbeat?.payload?.recoveryMetrics || this.lastRecoveryMetrics || null;
    const lastError = this.events.slice().reverse().find(e => e.level === 'error') || null;
    const rootCause = this.currentHeartbeat?.payload?.lastFailure || lastError?.msg || null;

    return {
      ts: Date.now(),
      subsystems: this.subsystems,
      events: this.events.slice().reverse().slice(0, this.maxEvents),
      lastError,
      rootCause,
      lastFailure: this.currentHeartbeat?.payload?.lastFailure || null,
      currentServerTime: Date.now(),
      currentClientTime: this.lastClientTime,
      timezone: this.timezone,
      clockDriftMs: this.clockDriftMs,
      lastPromptTimestamp: this.lastPromptTimestamp,
      lastTimeSync: this.lastTimeSync,
      currentRuntimeState: currentConnection || null,
      runtimeUptimeMs: Date.now() - this.runtimeStartTs,
      lastRuntimeContext: lastRuntimeContext,
      lastRuntimeContextAgeMs: lastRuntimeContextAge,
      lastRuntimeContextBuildTime: lastRuntimeContextBuildTime,
      lastRuntimeRefresh: lastRuntimeRefresh,
      currentHeartbeat: this.currentHeartbeat,
      lastHeartbeat: this.lastHeartbeat,
      heartbeatDelayMs: this.currentHeartbeat && this.currentHeartbeat.runtimeTimestamp ? Date.now() - this.currentHeartbeat.runtimeTimestamp : null,
      heartbeatMissCount: this.heartbeatMissCount,
      runtimeRestartCount: this.restartCounts.runtime || 0,
      geminiRestartCount: this.restartCounts.gemini || 0,
      websocketRestartCount: this.restartCounts.websocket || 0,
      voiceRestartCount: this.restartCounts.voice || 0,
      emotionRestartCount: this.restartCounts.emotion || 0,
      microphoneRestartCount: this.restartCounts.microphone || 0,
      audioRestartCount: this.restartCounts.audio || 0,
      recoveryCount: this.recoveryCount,
      currentConnection,
      currentInternet,
      currentSession,
      currentRuntimeVersion: this.runtimeVersion,
      currentBuildNumber: this.buildNumber,
      currentActiveRequest: activeRequest,
      currentPendingRequests: pendingRequests,
      currentAudioQueue,
      currentEmotion,
      currentVoice,
      currentListeningState: currentListening,
      currentSpeakingState: currentSpeaking,
      currentAvatarState: currentAvatar,
      currentDeviceState: currentDevice,
      currentBattery,
      runtimeMode,
      healthSummary: heartbeatHealthSummary,
      recoveryMetrics,
      overallRuntimeHealth: heartbeatHealthSummary?.overallHealthScore ?? null,
      currentBottleneck: heartbeatHealthSummary?.currentBottleneck ?? null,
      slowestComponent: heartbeatHealthSummary?.slowestComponent ?? null,
      mostRestartedComponent: heartbeatHealthSummary?.mostRestartedComponent ?? null,
      mostUnstableComponent: heartbeatHealthSummary?.mostUnstableComponent ?? null,
      warningCounters: this.warningCounters,
      recentGeminiRequests: this.geminiRequests.slice().reverse().slice(0, 50),
    };
  }
}

const supervisor = new ServerRuntimeSupervisor();
module.exports = supervisor;
