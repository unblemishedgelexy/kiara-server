const Groq = require('groq-sdk');
const { env } = require('../config/env');

const GROQ_TEXT_MODEL = 'openai/gpt-oss-20b';
let client;

const NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
]);

function safeProviderCode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
    ? value
    : null;
}

function classifyGroqError(error) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  const errorBody = error?.error;
  const providerError = errorBody?.error && typeof errorBody.error === 'object'
    ? errorBody.error
    : errorBody;
  const providerCode = safeProviderCode(providerError?.code)
    || safeProviderCode(errorBody?.code)
    || safeProviderCode(error?.code);
  const providerType = safeProviderCode(providerError?.type)
    || safeProviderCode(errorBody?.type);
  const providerParam = safeProviderCode(providerError?.param)
    || safeProviderCode(errorBody?.param);
  const errorName = typeof error?.name === 'string' ? error.name : '';
  const causeCode = safeProviderCode(error?.cause?.code);

  let category = 'UNKNOWN_PROVIDER_ERROR';
  if (status === 401) category = 'AUTHENTICATION';
  else if (status === 403) category = 'PERMISSION';
  else if (status === 404) category = 'MODEL_OR_ENDPOINT';
  else if (status === 429) category = 'RATE_LIMIT';
  else if (status === 400 || status === 422) category = 'REQUEST_OR_MODEL';
  else if (status !== null && status >= 500) category = 'PROVIDER_SERVER';
  else if (errorName === 'APIConnectionTimeoutError' || causeCode === 'ETIMEDOUT') category = 'NETWORK_TIMEOUT';
  else if (errorName === 'APIConnectionError' || NETWORK_ERROR_CODES.has(causeCode)) category = 'NETWORK';
  else if (status !== null) category = 'PROVIDER_HTTP_ERROR';

  const requestId = safeProviderCode(
    error?.headers?.get?.('x-request-id')
      || error?.headers?.get?.('request-id')
      || error?.request_id,
  );

  return {
    category,
    httpStatus: status,
    providerCode,
    providerType,
    providerParam,
    requestId,
    errorName: safeProviderCode(errorName),
  };
}

function getGroqClient() {
  if (!env.groqApiKey) {
    throw new Error('Groq API key is not configured. Set GROQ_API_KEY.');
  }

  if (!client) {
    client = new Groq({ apiKey: env.groqApiKey });
  }

  return client;
}

async function generateText({
  systemInstruction,
  userMessage,
  maxCompletionTokens,
  timeoutMs,
  maxRetries,
  jsonSchema,
  reasoningEffort,
  jsonMode = false,
}) {
  if (typeof systemInstruction !== 'string' || !systemInstruction.trim()) {
    throw new TypeError('A non-empty system instruction is required.');
  }
  if (typeof userMessage !== 'string' || !userMessage.trim()) {
    throw new TypeError('A non-empty user message is required.');
  }

  const params = {
    model: GROQ_TEXT_MODEL,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userMessage },
    ],
    ...(Number.isFinite(maxCompletionTokens) ? { max_completion_tokens: maxCompletionTokens } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(jsonSchema
      ? { response_format: { type: 'json_schema', json_schema: jsonSchema } }
      : (jsonMode ? { response_format: { type: 'json_object' } } : {})),
  };
  const requestOptions = {
    ...(Number.isFinite(timeoutMs) ? { timeout: timeoutMs } : {}),
    ...(Number.isFinite(maxRetries) ? { maxRetries } : {}),
  };
  const completion = await getGroqClient().chat.completions.create(params, requestOptions);

  const text = completion.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw new Error('Groq returned no text response.');
  }

  return text.trim();
}

module.exports = { classifyGroqError, generateText, GROQ_TEXT_MODEL };
