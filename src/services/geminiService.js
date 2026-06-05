const { GoogleGenAI } = require('@google/genai');
const { env } = require('../config/env');
const {
  GEMINI_TEXT_MODEL,
  GEMINI_LIVE_SYSTEM_INSTRUCTION,
} = require('../config/constants');
const {
  createLiveConnectConfig,
  createPublicLiveSessionConfig,
  createLiveSessionConfig,
} = require('./liveConfig');

function hasGeminiServerAccess() {
  return Boolean(env.geminiApiKey);
}

function createGeminiClient(options = {}) {
  if (!env.geminiApiKey) {
    throw new Error('Gemini API key is not configured.');
  }
  return new GoogleGenAI({ apiKey: env.geminiApiKey, ...options });
}

async function summarizeConversation(input) {
  if (!hasGeminiServerAccess()) {
    return (input.transcript || '').slice(0, 1000);
  }

  try {
    const ai = createGeminiClient();
    const response = await ai.models.generateContent({
      model: GEMINI_TEXT_MODEL,
      contents: input.transcript || '',
      config: {
        candidateCount: 1,
        temperature: 0.3,
        maxOutputTokens: 256,
      },
    });
    return response.text || (input.transcript || '');
  } catch (err) {
    console.error('Gemini summarizeConversation failed:', err);
    return input.transcript || '';
  }
}

async function createLiveEphemeralToken() {
  if (!hasGeminiServerAccess()) {
    throw new Error('Gemini API key unavailable');
  }

  try {
    const ai = createGeminiClient({ httpOptions: { apiVersion: 'v1alpha' } });
    const expiresInSeconds = 30 * 60;
    const newSessionWindowSeconds = 60;
    const expireTime = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    const newSessionExpireTime = new Date(
      Date.now() + newSessionWindowSeconds * 1000
    ).toISOString();
    const sessionConfig = createLiveSessionConfig({
      model: env.geminiLiveModel,
      systemInstruction: GEMINI_LIVE_SYSTEM_INSTRUCTION,
      voiceName: env.geminiLiveVoice,
    });
    const liveConnectConfig = createLiveConnectConfig(sessionConfig);

    const liveToken = await ai.authTokens.create({
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

    if (!liveToken?.name) {
      throw new Error('Failed to create Gemini live ephemeral token.');
    }

    return {
      token: liveToken.name,
      expireTime,
      newSessionExpireTime,
      sessionConfig: createPublicLiveSessionConfig(sessionConfig),
    };
  } catch (error) {
    console.error('Gemini live token creation error:', error);
    throw new Error(error instanceof Error ? error.message : 'Unknown Gemini live token error');
  }
}

async function generateText({ prompt, model, temperature = 0.5, candidateCount = 1, maxOutputTokens = 512 }) {
  if (!hasGeminiServerAccess()) {
    throw new Error('Gemini API key is not configured.');
  }

  const ai = createGeminiClient();
  const response = await ai.models.generateContent({
    model: model || GEMINI_TEXT_MODEL,
    contents: prompt,
    config: {
      temperature,
      candidateCount,
      maxOutputTokens,
    },
  });

  return {
    text: response.text || '',
    raw: response,
  };
}

module.exports = { hasGeminiServerAccess, summarizeConversation, createLiveEphemeralToken, generateText };
