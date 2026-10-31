const fs = require('fs');
const path = require('path');
const { createHash, createHmac, randomUUID } = require('node:crypto');
const { GoogleGenAI } = require('@google/genai');
const { env } = require('../../config/env');
const { GEMINI_TEXT_MODEL } = require('../../config/constants');
const { LIVE_SYSTEM_INSTRUCTION } = require('./liveSystemInstruction');
const {
  createLiveConnectConfig,
  createPublicLiveSessionConfig,
  createLiveSessionConfig,
} = require('./liveConfig');
const TRACE_FILE_PATH = path.resolve(__dirname, '..', '..', 'GEMINI_REQUEST_TRACE.md');
const ENABLE_GEMINI_TRACE = process.env.GEMINI_TRACE === 'true';
const CONCURRENCY_LIMIT = 5;
const CIRCUIT_BREAKER_WINDOW_MS = 60 * 1000;
const CIRCUIT_BREAKER_THRESHOLD = 6;
const CIRCUIT_BREAKER_COOLDOWN_MS = 120 * 1000;
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
        '# Gemini Request Trace\n# timestamp | requestId | endpoint | retryCount | promptTokens | responseTokens | latency | status | concurrency\n'
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

function hasGeminiLiveAccess() {
  return env.liveGatewayUrl
    ? Boolean(env.liveGatewayHmacSecret)
    : hasGeminiServerAccess();
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
    const line = `${new Date(entry.timestamp).toISOString()} | requestId=${entry.requestId} | endpoint=${entry.endpoint} | retryCount=${entry.retryCount} | promptTokens=${entry.promptTokens} | responseTokens=${entry.responseTokens} | latency=${entry.latency}ms | status=${entry.status} | concurrency=${entry.concurrency}`;
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

  const quotaExhausted = status === 'resource_exhausted'
    || /(?:quota|daily limit|per[- ]day).*(?:exhaust|exceeded|depleted)|exhaust.*quota/.test(message);
  if (quotaExhausted) return false;

  return [429, 503, 502, 504].includes(code)
    || status === 'unavailable'
    || /temporar|timeout|rate limit|high demand/.test(message);
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

  const hasAccess = metadata?.isLive ? hasGeminiLiveAccess() : hasGeminiServerAccess();
  if (!hasAccess) {
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
const LIVE_GATEWAY_TOKEN_CREATION_TIMEOUT_MS = 40000;

async function createLiveTokenThroughGateway({
  expireTime,
  newSessionExpireTime,
  liveConnectConstraints,
  signal,
}) {
  if (!env.liveGatewayHmacSecret) {
    throw new Error('Live token gateway is configured without its signing secret.');
  }

  const gatewayUrl = new URL('/internal/v1/live-token', env.liveGatewayUrl);
  if (process.env.NODE_ENV === 'production' && gatewayUrl.protocol !== 'https:') {
    throw new Error('Live token gateway must use HTTPS in production.');
  }

  const body = JSON.stringify({
    expireTime,
    newSessionExpireTime,
    liveConnectConstraints,
  });
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const signature = createHmac('sha256', env.liveGatewayHmacSecret)
    .update(`${timestamp}.${nonce}.${bodyHash}`)
    .digest('hex');
  let response;
  try {
    response = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-kiara-timestamp': timestamp,
        'x-kiara-nonce': nonce,
        'x-kiara-signature': signature,
      },
      body,
      signal,
    });
  } catch (error) {
    const errorCode = typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code)
      ? error.code
      : error?.name === 'AbortError' ? 'ABORTED' : 'NETWORK_ERROR';
    console.error('[LIVE_GATEWAY_CONNECTION]', JSON.stringify({
      status: 'unreachable',
      errorCode,
    }));
    throw error;
  }

  console.info('[LIVE_GATEWAY_CONNECTION]', JSON.stringify({
    status: 'reachable',
    httpStatus: response.status,
  }));

  if (!response.ok) {
    const error = new Error(
      response.status === 503
        ? 'Live token gateway is temporarily at capacity.'
        : 'Live token gateway could not create a token.'
    );
    error.statusCode = response.status;
    throw error;
  }

  const result = await response.json();
  if (typeof result?.token !== 'string' || !result.token) {
    console.error('[LIVE_GATEWAY_TOKEN_RESPONSE_INVALID]', JSON.stringify({
      httpStatus: response.status,
    }));
    throw new Error('Live token gateway returned an invalid token response.');
  }
  console.info('[LIVE_GATEWAY_TOKEN_RECEIVED]', JSON.stringify({
    status: 'success',
    httpStatus: response.status,
  }));
  return { name: result.token };
}

async function createLiveEphemeralToken(requestingUserId = null, options = {}) {
  const lifecycleTrigger = options.lifecycleTrigger || 'LIVE_SESSION_START';
  if (!hasGeminiLiveAccess()) {
    throw new Error('Gemini API key or configured Live token gateway is unavailable.');
  }

  const ai = env.liveGatewayUrl
    ? null
    : createGeminiClient({ httpOptions: { apiVersion: 'v1alpha' } });
  const expiresInSeconds = 30 * 60;
  const newSessionWindowSeconds = 60;
  const expireTime = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  const newSessionExpireTime = new Date(
    Date.now() + newSessionWindowSeconds * 1000
  ).toISOString(  );

  const tokenWillStartNewSession = lifecycleTrigger !== 'LIVE_TOKEN_REFRESH';

  const sessionConfig = createLiveSessionConfig({
    model: env.geminiLiveModel,
    systemInstruction: LIVE_SYSTEM_INSTRUCTION,
    voiceName: env.geminiLiveVoice,
  });
  const liveConnectConfig = createLiveConnectConfig(sessionConfig);

  const tokenAbortController = new AbortController();
  const abortForCaller = () => tokenAbortController.abort();
  if (options.signal?.aborted) {
    tokenAbortController.abort();
  } else {
    options.signal?.addEventListener('abort', abortForCaller, { once: true });
  }

  const tokenCreationStartedAt = performance.now();
  const responsePromise = executeGeminiRequest({
    fn: async () => {
      if (env.liveGatewayUrl) {
        return createLiveTokenThroughGateway({
          expireTime,
          newSessionExpireTime,
          liveConnectConstraints: {
            model: sessionConfig.model,
            config: liveConnectConfig,
          },
          signal: tokenAbortController.signal,
        });
      }

      return ai.authTokens.create({
        config: {
          uses: 1,
          expireTime,
          newSessionExpireTime,
          abortSignal: tokenAbortController.signal,
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
    maxAttempts: 1,
  });

  let tokenCreationTimeout;
  const timeoutPromise = new Promise((_, reject) => {
    tokenCreationTimeout = setTimeout(
      () => {
        tokenAbortController.abort();
        reject(new Error('Live ephemeral token creation timed out.'));
      },
      env.liveGatewayUrl
        ? LIVE_GATEWAY_TOKEN_CREATION_TIMEOUT_MS
        : LIVE_TOKEN_CREATION_TIMEOUT_MS
    );
  });

  let response;
  try {
    response = await Promise.race([responsePromise, timeoutPromise]);
  } catch (error) {
    throw error;
  } finally {
    clearTimeout(tokenCreationTimeout);
    options.signal?.removeEventListener('abort', abortForCaller);
  }

  if (!response?.name) {
    throw new Error('Failed to create Gemini live ephemeral token.');
  }
  const dur = performance.now() - tokenCreationStartedAt;
  recordGeminiMetric('gemini_ephemeral_token_generation', dur, { isLive: true });

  return {
    token: response.name,
    expireTime,
    newSessionExpireTime,
    sessionConfig: createPublicLiveSessionConfig(sessionConfig),
    memoryContextStatus: 'DEFERRED_POST_CONNECT',
    memoryContextCount: 0,
    memoryContextHash: null,
    identityStatus: 'DEFERRED_POST_CONNECT',
    instructionScope: tokenWillStartNewSession ? 'NEW_SESSION' : 'FUTURE_RECONNECT',
    lifecycleTrigger,
  };
}

async function generateText({ prompt, model, temperature = 0.5, candidateCount = 1, maxOutputTokens = 512, userId = null, sessionId = null, maxAttempts = 3 }) {
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
    maxAttempts,
  });

  return {
    text: response.text || '',
    raw: response,
  };
}

module.exports = {
  hasGeminiServerAccess,
  hasGeminiLiveAccess,
  summarizeConversation,
  createLiveEphemeralToken,
  generateText,
};
