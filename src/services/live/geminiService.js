const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const { env } = require('../../config/env');
const logger = require('../memory/utils/memoryLogger');
const { log: traceLog } = require('../memory/utils/memoryTrace');
const { isMemoryEligible, markLiveSessionHealth } = require('../memory/memoryStabilityGate');
const {
  GEMINI_TEXT_MODEL,
  GEMINI_LIVE_SYSTEM_INSTRUCTION,
} = require('../../config/constants');
const {
  createLiveConnectConfig,
  createPublicLiveSessionConfig,
  createLiveSessionConfig,
} = require('./liveConfig');

// Attempt to load optional system prompt builder (builds system prompt from working memory)
let systemPromptBuilder = null;
try {
  systemPromptBuilder = require('./systemPromptBuilder');
} catch (e) {
  systemPromptBuilder = null;
}
const TRACE_FILE_PATH = path.resolve(__dirname, '..', '..', 'GEMINI_REQUEST_TRACE.md');
const ENABLE_GEMINI_TRACE = process.env.GEMINI_TRACE === 'true';
const CONCURRENCY_LIMIT = 5;
const CIRCUIT_BREAKER_WINDOW_MS = 60 * 1000;
const CIRCUIT_BREAKER_THRESHOLD = 6;
const CIRCUIT_BREAKER_COOLDOWN_MS = 120 * 1000;
const PROMPT_BUILDER_TIMEOUT_MS = 3000;

// Separate concurrency and circuit-breaker for background (text) vs live-critical calls.
const geminiConcurrency = new Set();
const geminiConcurrencyLive = new Set();
let circuitBreaker = {
  failures: [],
  openUntil: 0,
};
let circuitBreakerLive = {
  failures: [],
  openUntil: 0,
};

function initializeTraceFile() {
  if (!ENABLE_GEMINI_TRACE) {
    return;
  }

  try {
    if (!fs.existsSync(TRACE_FILE_PATH)) {
      fs.writeFileSync(
        TRACE_FILE_PATH,
        '# Gemini Request Trace\n# timestamp | requestId | userId | sessionId | endpoint | retryCount | promptTokens | responseTokens | latency | status | concurrency\n'
      );
    }
  } catch (err) {
    console.error('[ERROR]', 'Failed to initialize Gemini trace file:', err && err.message ? err.message : err);
  }
}

initializeTraceFile();

function hasGeminiServerAccess() {
  return Boolean(env.geminiApiKey);
}

function createGeminiClient(options = {}) {
  if (!env.geminiApiKey) {
    throw new Error('Gemini API key is not configured.');
  }
  return new GoogleGenAI({ apiKey: env.geminiApiKey, ...options });
}

function getGeminiErrorCode(error) {
  const codeRaw = error?.error?.code || error?.status || error?.code || error?.statusCode || null;
  if (typeof codeRaw === 'string') {
    const numeric = Number(codeRaw.replace(/[^0-9]/g, ''));
    return Number.isFinite(numeric) ? numeric : null;
  }
  const code = Number(codeRaw);
  return Number.isFinite(code) ? code : null;
}

function parseGeminiRetryDelayMs(error) {
  const details = error?.error?.details || error?.details;
  if (!Array.isArray(details)) return null;

  for (const item of details) {
    if (item['@type'] === 'type.googleapis.com/google.rpc.RetryInfo' && item.retryDelay) {
      const retryDelay = item.retryDelay;
      if (typeof retryDelay === 'string') {
        const secondsMatch = retryDelay.match(/(\d+(?:\.\d+)?)s/);
        if (secondsMatch) return Math.ceil(Number(secondsMatch[1]) * 1000);
      }
      if (typeof retryDelay === 'object') {
        const seconds = Number(retryDelay.seconds || 0);
        const nanos = Number(retryDelay.nanos || 0);
        return Math.ceil(seconds * 1000 + nanos / 1000000);
      }
    }
  }

  return null;
}

function now() {
  return Date.now();
}

function recordGeminiFailure(isLive = false) {
  const timestamp = now();
  const cb = isLive ? circuitBreakerLive : circuitBreaker;
  cb.failures = cb.failures.filter((ts) => ts > timestamp - CIRCUIT_BREAKER_WINDOW_MS);
  cb.failures.push(timestamp);
  if (cb.failures.length >= CIRCUIT_BREAKER_THRESHOLD) {
    cb.openUntil = timestamp + CIRCUIT_BREAKER_COOLDOWN_MS;
    console.error('[ERROR]', `Gemini ${isLive ? 'live' : 'text'} circuit breaker opened until`, new Date(cb.openUntil).toISOString());
  }
}

function isCircuitBreakerOpen(isLive = false) {
  const cb = isLive ? circuitBreakerLive : circuitBreaker;
  return now() < (cb.openUntil || 0);
}

function writeTraceEntry(entry) {
  if (!ENABLE_GEMINI_TRACE) {
    return;
  }

  try {
    const line = `${new Date(entry.timestamp).toISOString()} | requestId=${entry.requestId} | userId=${entry.userId || 'unknown'} | sessionId=${entry.sessionId || 'unknown'} | endpoint=${entry.endpoint} | retryCount=${entry.retryCount} | promptTokens=${entry.promptTokens} | responseTokens=${entry.responseTokens} | latency=${entry.latency}ms | status=${entry.status} | concurrency=${entry.concurrency}`;
    fs.appendFileSync(TRACE_FILE_PATH, `${line}\n`);
  } catch (err) {
    console.error('[ERROR]', 'Failed to write Gemini trace:', err && err.message ? err.message : err);
  }
}

// Record summary metrics to perf collector when available
function recordGeminiMetric(name, duration, meta) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const perf = require('../../middleware/perfCollector');
    if (perf && perf.record) {
      perf.record(name, duration, meta);
    }
    if (perf && perf.recordGemini) {
      perf.recordGemini(Object.assign({ name, duration }, meta || {}));
    }
  } catch {}
}

function buildTraceMetadata({ requestId, userId, sessionId, endpoint }) {
  return {
    requestId: requestId || `req-${Math.random().toString(36).slice(2, 10)}`,
    userId: userId || null,
    sessionId: sessionId || null,
    endpoint: endpoint || 'unknown',
  };
}

function isRetryableGeminiError(error) {
  const code = Number(getGeminiErrorCode(error));
  const message = String(error?.message || error?.error?.message || '').toLowerCase();
  const status = String(error?.error?.status || error?.status || '').toLowerCase();

  return [429, 503, 502, 504].includes(code)
    || status === 'resource_exhausted'
    || status === 'unavailable'
    || /temporar|timeout|quota.*exceed|rate limit|high demand/.test(message);
}

function getGeminiUsage(response) {
  const usage = response?.usage || response?.metadata?.usage || response?.data?.usage || {};
  const promptTokens = Number(usage?.promptTokens || usage?.prompt_tokens || 0) || 0;
  const responseTokens = Number(usage?.completionTokens || usage?.completion_tokens || usage?.responseTokens || usage?.response_tokens || usage?.totalTokens || 0) || 0;
  return { promptTokens, responseTokens };
}

async function executeGeminiRequest({ fn, metadata = {}, endpoint = 'unknown', maxAttempts = 3 }) {
  const safeMaxAttempts = Number.isFinite(Number(maxAttempts)) && Number(maxAttempts) > 0 ? Number(maxAttempts) : 3;
  const traceMeta = buildTraceMetadata({ ...metadata, endpoint });
  const requestId = traceMeta.requestId;
  const start = now();
  logger.geminiRequest({
    requestId,
    ...traceMeta,
    endpoint,
    retryCount: 0,
    status: 'started',
    concurrency: geminiConcurrency.size,
    timestamp: new Date().toISOString(),
  });

  if (!hasGeminiServerAccess()) {
    const timestamp = now();
    writeTraceEntry({
      ...traceMeta,
      retryCount: 0,
      promptTokens: 0,
      responseTokens: 0,
      latency: 0,
      endpoint,
      status: 'BLOCKED',
      concurrency: geminiConcurrency.size,
      timestamp,
    });
    const err = new Error('Gemini API key is not configured.');
    err.status = 'BLOCKED';
    throw err;
  }

  if (isCircuitBreakerOpen(metadata?.isLive)) {
    const timestamp = now();
    writeTraceEntry({
      ...traceMeta,
      retryCount: 0,
      promptTokens: 0,
      responseTokens: 0,
      latency: 0,
      endpoint,
      status: 'BLOCKED',
      concurrency: metadata?.isLive ? geminiConcurrencyLive.size : geminiConcurrency.size,
      timestamp,
    });
    const err = new Error('Gemini service temporarily blocked by circuit breaker.');
    err.status = 'BLOCKED';
    throw err;
  }

  const concurrencySet = metadata?.isLive ? geminiConcurrencyLive : geminiConcurrency;
  if (concurrencySet.size >= CONCURRENCY_LIMIT) {
    const timestamp = now();
    writeTraceEntry({
      ...traceMeta,
      retryCount: 0,
      promptTokens: 0,
      responseTokens: 0,
      latency: 0,
      endpoint,
      status: 'BLOCKED',
      concurrency: concurrencySet.size,
      timestamp,
    });
    const err = new Error('Gemini concurrency limit exceeded.');
    err.status = 'BLOCKED';
    throw err;
  }

  concurrencySet.add(requestId);
  let attempt = 0;
  let lastError;

  try {
    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        const response = await fn();
        const usage = getGeminiUsage(response);
        const latency = now() - start;
        writeTraceEntry({
          ...traceMeta,
          retryCount: attempt - 1,
          promptTokens: usage.promptTokens,
          responseTokens: usage.responseTokens,
          latency,
          endpoint,
          status: 'OK',
          concurrency: geminiConcurrency.size,
          timestamp: now(),
        });
        logger.geminiResponse({
          requestId,
          ...traceMeta,
          endpoint,
          retryCount: attempt - 1,
          status: 'OK',
          promptTokens: usage.promptTokens,
          responseTokens: usage.responseTokens,
          latency,
          concurrency: geminiConcurrency.size,
        });
        console.info('[GEMINI_RESPONSE_RECEIVED]', JSON.stringify({
          requestId,
          userId: traceMeta.userId,
          sessionId: traceMeta.sessionId,
          endpoint,
          promptTokens: usage.promptTokens,
          responseTokens: usage.responseTokens,
          latency,
          status: 'OK',
          timestamp: new Date().toISOString(),
        }));
        return response;
      } catch (err) {
        lastError = err;
        const retryDelayMs = parseGeminiRetryDelayMs(err) || Math.min(30000, 1000 * attempt * 3 + Math.floor(Math.random() * 300));
        const retryable = isRetryableGeminiError(err);
        const latency = now() - start;
        const status = retryable ? 'RETRYABLE_ERROR' : 'ERROR';
        writeTraceEntry({
          ...traceMeta,
          retryCount: attempt,
          promptTokens: 0,
          responseTokens: 0,
          latency,
          endpoint,
          status,
          concurrency: geminiConcurrency.size,
          timestamp: now(),
        });
        logger.geminiResponse({
          requestId,
          ...traceMeta,
          endpoint,
          retryCount: attempt,
          status,
          latency,
          concurrency: geminiConcurrency.size,
          error: err.message || String(err),
        });

        if (!retryable || attempt >= safeMaxAttempts) {
          if (retryable && attempt >= safeMaxAttempts) {
            // record failure on the correct circuit breaker
            recordGeminiFailure(metadata?.isLive);
          }
          throw err;
        }

        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  } finally {
    concurrencySet.delete(requestId);
  }

  throw lastError;
}

async function summarizeConversation(input) {
  if (!hasGeminiServerAccess()) {
    return (input.transcript || '').slice(0, 1000);
  }

  try {
    const ai = createGeminiClient();
    const response = await executeGeminiRequest({
      fn: async () => ai.models.generateContent({
        model: GEMINI_TEXT_MODEL,
        contents: input.transcript || '',
        config: {
          candidateCount: 1,
          temperature: 0.3,
          maxOutputTokens: 256,
        },
      }),
      metadata: { userId: input.userId || null, sessionId: input.sessionId || null },
      endpoint: 'summarizeConversation',
      maxAttempts: 3,
    });
    return response.text || (input.transcript || '');
  } catch (err) {
    console.error('[ERROR]', 'Gemini summarizeConversation failed:', err instanceof Error ? err.message : err);
    return input.transcript || '';
  }
}

const LIVE_TOKEN_CREATION_TIMEOUT_MS = 12000;

async function createLiveEphemeralToken(requestingUserId = null, options = {}) {
  const requestStartedAt = Date.now();
  const userQuery = options.userQuery || '';
  const sessionId = options.sessionId || requestingUserId || 'anonymous';
  const activeContext = options.activeContext || {};
  const memoryTraceId = options.memoryTraceId || `memtrace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  console.info('[GEMINI_REQUEST_STARTED]', JSON.stringify({ operation: 'createLiveEphemeralToken', userId: requestingUserId || 'anonymous', sessionId, question: String(userQuery || '').slice(0, 180), timestamp: new Date().toISOString() }));
  if (!hasGeminiServerAccess()) {
    throw new Error('Gemini API key unavailable');
  }

  const ai = createGeminiClient({ httpOptions: { apiVersion: 'v1alpha' } });
  markLiveSessionHealth({
    userId: requestingUserId || 'anonymous',
    sessionId,
    connected: true,
    audioReady: true,
    healthy: true,
    timestamp: Date.now(),
  });
  const expiresInSeconds = 30 * 60;
  const newSessionWindowSeconds = 60;
  const expireTime = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  const newSessionExpireTime = new Date(
    Date.now() + newSessionWindowSeconds * 1000
  ).toISOString();

  // Build dynamic system instruction including user memories only after the
  // live session has met the stability gate. Until then, the live path stays
  // intentionally minimal: user microphone -> Gemini Live -> response -> audio.
  let dynamicSystemInstruction = GEMINI_LIVE_SYSTEM_INSTRUCTION;
  let promptBuilderApplied = false;
  const memoryGateOpen = Boolean(requestingUserId && sessionId && isMemoryEligible(requestingUserId, sessionId));

  if (requestingUserId && systemPromptBuilder && memoryGateOpen) {
    try {
      console.info('[GEMINI_PROMPT_BUILDER_START]', JSON.stringify({ userId: requestingUserId, trigger: 'session_start', timestamp: new Date().toISOString() }));
      const built = await Promise.race([
        systemPromptBuilder.buildSystemPrompt(requestingUserId, {
          tokenBudget: 1800,
          trigger: 'session_start',
          userQuery,
          sessionId,
          activeContext,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('systemPromptBuilder timeout')), PROMPT_BUILDER_TIMEOUT_MS)),
      ]);
      if (built && built.systemPrompt) {
        dynamicSystemInstruction = `${GEMINI_LIVE_SYSTEM_INSTRUCTION}\n\n${built.systemPrompt}`;
        promptBuilderApplied = true;
        console.info('[GEMINI_CONTEXT_AFTER_INJECTION]', JSON.stringify({
          userId: requestingUserId,
          memoryCharacters: built.systemPrompt.length,
          estimatedTokens: Math.ceil(built.systemPrompt.length / 4),
          finalInstructionCharacters: dynamicSystemInstruction.length,
          timestamp: new Date().toISOString(),
          source: 'geminiService',
        }));
        try {
          const preview = String(built.systemPrompt || '').slice(0, 2000);
          console.log('[GEMINI_FINAL_PROMPT_PREVIEW]', JSON.stringify({ userId: requestingUserId, preview }));
        } catch (e) {}
      } else {
        console.info('[GEMINI_PROMPT_BUILDER_NO_INJECTION]', JSON.stringify({ userId: requestingUserId, timestamp: new Date().toISOString() }));
      }
    } catch (e) {
      console.error('[ERROR]', 'Failed to build dynamic system prompt for Gemini:', e && e.message ? e.message : e);
    }
  } else if (requestingUserId) {
    console.info('[GEMINI_PROMPT_BUILDER_SKIPPED]', JSON.stringify({ userId: requestingUserId, reason: memoryGateOpen ? 'builder_missing' : 'memory_gate_closed', timestamp: new Date().toISOString() }));
  }

  const sessionConfig = createLiveSessionConfig({
    model: env.geminiLiveModel,
    systemInstruction: dynamicSystemInstruction,
    voiceName: env.geminiLiveVoice,
  });
  traceLog('gemini_request', {
    memoryTraceId,
    requestId: `gemini_${Date.now()}`,
    systemInstruction: String(sessionConfig.systemInstruction || '').slice(0, 2000),
    memoryContext: String(dynamicSystemInstruction || '').slice(0, 2000),
    conversationContext: JSON.stringify({ sessionId, userQuery, activeContext }),
    userMessage: String(userQuery || ''),
  });
  const liveConnectConfig = createLiveConnectConfig(sessionConfig);
  console.info('[GEMINI_SESSION_CONFIG]', JSON.stringify({
    userId: requestingUserId || 'anonymous',
    model: sessionConfig.model,
    responseModalities: sessionConfig.responseModalities,
    voiceName: sessionConfig.voiceName,
    systemInstructionLength: String(sessionConfig.systemInstruction || '').length,
    promptBuilderApplied,
    timestamp: new Date().toISOString(),
  }));

  const start = now();
  const responsePromise = executeGeminiRequest({
    fn: async () => {
      return ai.authTokens.create({
        config: {
          uses: 1,
          expireTime,
          newSessionExpireTime,
          httpOptions: {
            apiVersion: 'v1alpha',
          },
          liveConnectConstraints: {
            model: sessionConfig.model,
            config: liveConnectConfig,
          },
        },
      });
    },
    metadata: { userId: requestingUserId || 'anonymous', sessionId: null, isLive: true },
    endpoint: 'authTokens.create',
    maxAttempts: 3,
  });

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Live ephemeral token creation timed out.')), LIVE_TOKEN_CREATION_TIMEOUT_MS);
  });

  const response = await Promise.race([responsePromise, timeoutPromise]);
  traceLog('gemini_response', { memoryTraceId, requestId: `gemini_${Date.now()}`, responseText: String(response?.name || ''), model: sessionConfig.model || env.geminiLiveModel || 'unknown' });

  if (!response?.name) {
    throw new Error('Failed to create Gemini live ephemeral token.');
  }

  try {
    const dur = now() - start;
    console.info('[PIPELINE_STAGE]', `name=gemini_ephemeral_token_generation durationMs=${dur}`);
    console.info('[GEMINI_REQUEST_FINISHED]', JSON.stringify({ operation: 'createLiveEphemeralToken', userId: requestingUserId || 'anonymous', durationMs: Date.now() - requestStartedAt, timestamp: new Date().toISOString() }));
    try { recordGeminiMetric('gemini_ephemeral_token_generation', dur, { userId: requestingUserId }); } catch {}
  } catch {}

  // Save mapping from token name -> requesting user id for audit/troubleshooting
  try {
    const liveTokenStore = require('./liveTokenStore');
    liveTokenStore.saveTokenMapping(response.name, requestingUserId || 'anonymous', expireTime);
  } catch (e) {
    // non-fatal
  }

  return {
    token: response.name,
    expireTime,
    newSessionExpireTime,
    sessionConfig: createPublicLiveSessionConfig(sessionConfig),
  };
}

async function generateText({ prompt, model, temperature = 0.5, candidateCount = 1, maxOutputTokens = 512, userId = null, sessionId = null }) {
  if (!hasGeminiServerAccess()) {
    throw new Error('Gemini API key is not configured.');
  }

  const ai = createGeminiClient();
  const response = await executeGeminiRequest({
    fn: async () => {
      return ai.models.generateContent({
        model: model || GEMINI_TEXT_MODEL,
        contents: prompt,
        config: {
          temperature,
          candidateCount,
          maxOutputTokens,
        },
      });
    },
    metadata: { userId, sessionId },
    endpoint: 'models.generateContent',
    maxAttempts: 3,
  });

  return {
    text: response.text || '',
    raw: response,
  };
}

module.exports = { hasGeminiServerAccess, summarizeConversation, createLiveEphemeralToken, generateText };
