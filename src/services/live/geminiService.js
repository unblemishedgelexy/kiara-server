const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const { env } = require('../../config/env');
const {
  GEMINI_TEXT_MODEL,
  GEMINI_LIVE_SYSTEM_INSTRUCTION,
  buildGeminiLiveSystemInstruction,
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
const PROMPT_BUILDER_TIMEOUT_MS = 15000;
const SYSTEM_PROMPT_CACHE_TTL_MS = 15000;
const SESSION_PROMPT_CACHE_TTL_MS = 35 * 60 * 1000;
const MAX_SESSION_PROMPT_CACHE_ENTRIES = 500;
const systemPromptCache = new Map();
const sessionPromptCache = new Map();

function createPromptCacheKey(userId, sessionId, userQuery, activeContext) {
  const normalizedQuery = String(userQuery || '').trim();
  const normalizedContext = activeContext && typeof activeContext === 'object'
    ? JSON.stringify(activeContext)
    : '{}';
  return `${userId || 'anonymous'}::${sessionId || 'anonymous'}::${normalizedQuery}::${normalizedContext}`;
}

function createSessionPromptCacheKey(userId, sessionId, traceId) {
  return JSON.stringify([userId || 'anonymous', sessionId || 'anonymous', traceId || 'untraced']);
}

function getSessionPrompt(cacheKey, timestamp = Date.now()) {
  const cachedPrompt = sessionPromptCache.get(cacheKey);
  if (!cachedPrompt) return null;
  if (timestamp - cachedPrompt.timestamp > SESSION_PROMPT_CACHE_TTL_MS) {
    clearTimeout(cachedPrompt.cleanupTimer);
    sessionPromptCache.delete(cacheKey);
    return null;
  }
  return cachedPrompt;
}

function setSessionPrompt(cacheKey, prompt) {
  const previous = sessionPromptCache.get(cacheKey);
  if (previous) clearTimeout(previous.cleanupTimer);
  sessionPromptCache.delete(cacheKey);
  const entry = {
    ...prompt,
    timestamp: Date.now(),
    cleanupTimer: setTimeout(() => {
      if (sessionPromptCache.get(cacheKey) === entry) {
        sessionPromptCache.delete(cacheKey);
      }
    }, SESSION_PROMPT_CACHE_TTL_MS),
  };
  entry.cleanupTimer.unref?.();
  sessionPromptCache.set(cacheKey, entry);
  while (sessionPromptCache.size > MAX_SESSION_PROMPT_CACHE_ENTRIES) {
    const oldestKey = sessionPromptCache.keys().next().value;
    const oldest = sessionPromptCache.get(oldestKey);
    clearTimeout(oldest?.cleanupTimer);
    sessionPromptCache.delete(oldestKey);
  }
}

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

async function createLiveEphemeralToken(requestingUserId = null, options = {}) {
  const userQuery = options.userQuery || '';
  const sessionId = options.sessionId || requestingUserId || 'anonymous';
  const activeContext = options.activeContext || {};
  const lifecycleTrigger = options.lifecycleTrigger || 'LIVE_SESSION_START';
  const traceId = String(options.traceId || `live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  if (!hasGeminiServerAccess()) {
    throw new Error('Gemini API key unavailable');
  }

  const ai = createGeminiClient({ httpOptions: { apiVersion: 'v1alpha' } });
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
  let memoryRevision = 0;
  let contextMemoryRevision = 0;
  let memoryStatus = 'NOT_BUILT';
  let memoryCount = 0;
  let memoryContextHash = null;
  let identityStatus = 'NOT_CHECKED';
  const tokenWillStartNewSession = lifecycleTrigger !== 'LIVE_TOKEN_REFRESH';
  const sessionPromptCacheKey = createSessionPromptCacheKey(requestingUserId, sessionId, traceId);
  const cachedSessionPrompt = lifecycleTrigger === 'LIVE_TOKEN_REFRESH'
    ? getSessionPrompt(sessionPromptCacheKey)
    : null;

  if (cachedSessionPrompt) {
    dynamicSystemInstruction = cachedSessionPrompt.systemInstruction;
    promptBuilderApplied = true;
    memoryRevision = Number(cachedSessionPrompt.memoryRevision) || 0;
    contextMemoryRevision = Number(cachedSessionPrompt.contextMemoryRevision) || memoryRevision;
    memoryStatus = cachedSessionPrompt.memoryStatus || 'UNKNOWN';
    memoryCount = Number(cachedSessionPrompt.memoryCount) || 0;
    memoryContextHash = cachedSessionPrompt.memoryContextHash || null;
    identityStatus = cachedSessionPrompt.identityStatus || 'UNKNOWN';
    setSessionPrompt(sessionPromptCacheKey, cachedSessionPrompt);
  } else if (requestingUserId) {
    if (!systemPromptBuilder) {
      const error = new Error('Live system prompt builder is unavailable.');
      error.code = 'SYSTEM_PROMPT_BUILDER_UNAVAILABLE';
      throw error;
    }

    let promptBuilderTimeout = null;
    let cacheKey = null;
    try {
      cacheKey = createPromptCacheKey(requestingUserId, sessionId, userQuery, activeContext);
      const cachedPrompt = systemPromptCache.get(cacheKey);
      const now = Date.now();
      if (cachedPrompt
        && !['RETRIEVAL_FAILURE', 'PARTIAL'].includes(cachedPrompt.memoryStatus)
        && now - cachedPrompt.timestamp <= SYSTEM_PROMPT_CACHE_TTL_MS) {
        dynamicSystemInstruction = cachedPrompt.systemInstruction;
        promptBuilderApplied = true;
        memoryRevision = Number(cachedPrompt.memoryRevision) || 0;
        contextMemoryRevision = Number(cachedPrompt.contextMemoryRevision) || memoryRevision;
        memoryStatus = cachedPrompt.memoryStatus || 'UNKNOWN';
        memoryCount = Number(cachedPrompt.memoryCount) || 0;
        memoryContextHash = cachedPrompt.memoryContextHash || null;
        identityStatus = cachedPrompt.identityStatus || 'UNKNOWN';
      } else {
        const built = await Promise.race([
          systemPromptBuilder.buildSystemPrompt(requestingUserId, {
            tokenBudget: 1800,
            trigger: 'session_start',
            lifecycleTrigger,
            userQuery,
            sessionId,
            activeContext,
            traceId,
          }),
          new Promise((_, reject) => {
            promptBuilderTimeout = setTimeout(
              () => reject(new Error('systemPromptBuilder timeout')),
              PROMPT_BUILDER_TIMEOUT_MS
            );
          }),
        ]);
        if (!built?.systemPrompt) {
          const error = new Error('Live prompt initialization returned no instruction.');
          error.code = 'EMPTY_SYSTEM_PROMPT';
          throw error;
        }

        dynamicSystemInstruction = `${GEMINI_LIVE_SYSTEM_INSTRUCTION}\n\n${built.systemPrompt}`;
        promptBuilderApplied = true;
        memoryRevision = Number(built.memoryRevision) || 0;
        contextMemoryRevision = Number(built.contextMemoryRevision) || memoryRevision;
        memoryStatus = built.memoryStatus || 'UNKNOWN';
        memoryCount = Number(built.memoryCount) || 0;
        memoryContextHash = built.memoryContextHash || null;
        identityStatus = built.identityStatus || 'UNKNOWN';
        if (memoryStatus === 'RETRIEVAL_FAILURE' || memoryStatus === 'PARTIAL') {
          systemPromptCache.delete(cacheKey);
        } else {
          systemPromptCache.set(cacheKey, {
            systemInstruction: dynamicSystemInstruction,
            memoryRevision,
            contextMemoryRevision,
            memoryStatus,
            memoryCount,
            memoryContextHash,
            identityStatus,
            timestamp: now,
          });
        }
      }

      if (memoryStatus === 'RETRIEVAL_FAILURE' || memoryStatus === 'PARTIAL') {
        const previous = sessionPromptCache.get(sessionPromptCacheKey);
        if (previous) clearTimeout(previous.cleanupTimer);
        sessionPromptCache.delete(sessionPromptCacheKey);
      } else {
        setSessionPrompt(sessionPromptCacheKey, {
          systemInstruction: dynamicSystemInstruction,
          memoryRevision,
          contextMemoryRevision,
          memoryStatus,
          memoryCount,
          memoryContextHash,
          identityStatus,
        });
      }
    } catch (error) {
      if (cacheKey) systemPromptCache.delete(cacheKey);
      const previousSessionPrompt = sessionPromptCache.get(sessionPromptCacheKey);
      if (previousSessionPrompt) clearTimeout(previousSessionPrompt.cleanupTimer);
      sessionPromptCache.delete(sessionPromptCacheKey);
      throw error;
    } finally {
      if (promptBuilderTimeout) clearTimeout(promptBuilderTimeout);
    }
  }

  const sessionConfig = createLiveSessionConfig({
    model: env.geminiLiveModel,
    systemInstruction: dynamicSystemInstruction,
    voiceName: env.geminiLiveVoice,
  });
  const liveConnectConfig = createLiveConnectConfig(sessionConfig);

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
    maxAttempts: 1,
  });

  let tokenCreationTimeout;
  const timeoutPromise = new Promise((_, reject) => {
    tokenCreationTimeout = setTimeout(
      () => reject(new Error('Live ephemeral token creation timed out.')),
      LIVE_TOKEN_CREATION_TIMEOUT_MS
    );
  });

  let response;
  try {
    response = await Promise.race([responsePromise, timeoutPromise]);
  } finally {
    clearTimeout(tokenCreationTimeout);
  }

  if (!response?.name) {
    throw new Error('Failed to create Gemini live ephemeral token.');
  }
  const dur = now() - start;
  recordGeminiMetric('gemini_ephemeral_token_generation', dur, { userId: requestingUserId });

  // Save mapping from token name -> requesting user id for audit/troubleshooting
  try {
    const liveTokenStore = require('./liveTokenStore');
    liveTokenStore.saveTokenMapping(response.name, requestingUserId || 'anonymous', expireTime);
  } catch (error) {
    console.warn('[LIVE_TOKEN_MAPPING]', JSON.stringify({
      status: 'FAILED',
      errorCode: error?.code || error?.name || 'TOKEN_MAPPING_FAILURE',
    }));
  }

  return {
    token: response.name,
    expireTime,
    newSessionExpireTime,
    sessionConfig: createPublicLiveSessionConfig(sessionConfig),
    memoryContextStatus: promptBuilderApplied ? memoryStatus : 'PROMPT_BUILD_FAILURE',
    memoryContextCount: promptBuilderApplied ? memoryCount : 0,
    memoryContextHash: promptBuilderApplied ? memoryContextHash : null,
    identityStatus,
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

module.exports = { hasGeminiServerAccess, summarizeConversation, createLiveEphemeralToken, generateText };
