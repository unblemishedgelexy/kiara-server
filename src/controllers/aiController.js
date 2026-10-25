const { generateText } = require('../services/../services/live/geminiService');
const groqService = require('../services/groqService');
const subscriptionUsageService = require('../services/subscriptions/usageService');
const { env } = require('../config/env');
const { GEMINI_TEXT_MODEL } = require('../config/constants');

const NETWORK_FAILURES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
]);

function shouldFallbackToGroq(error, request) {
  if (
    !env.groqTextFallbackEnabled
    || !env.groqApiKey
    || (request.model && request.model !== GEMINI_TEXT_MODEL)
    || (request.candidateCount && request.candidateCount !== 1)
  ) {
    return false;
  }

  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  const code = error?.code || error?.cause?.code;
  return status === 408 || status === 429 || status >= 500 || NETWORK_FAILURES.has(code);
}

async function generateTextController(req, res, next) {
  let reservation;
  let usageCommitted = false;
  try {
    const { prompt, model, temperature, candidateCount, maxOutputTokens } = req.body;
    reservation = await subscriptionUsageService.reserveChatMessage(req.userId);
    let result;
    try {
      result = await generateText({
        prompt,
        model,
        temperature,
        candidateCount,
        maxOutputTokens,
        userId: req.userId,
        sessionId: req.sessionID || null,
      });
    } catch (error) {
      if (!shouldFallbackToGroq(error, { model, candidateCount })) throw error;
      const text = await groqService.generateText({
        systemInstruction: 'You are Kiara, a helpful conversational AI assistant. Answer accurately and concisely.',
        userMessage: prompt,
        maxCompletionTokens: maxOutputTokens || 512,
        timeoutMs: 10000,
        maxRetries: 0,
      });
      result = { text, raw: { provider: 'groq' } };
      console.warn('[AI_TEXT_PROVIDER_FALLBACK]', JSON.stringify({
        requestId: req.requestId || null,
        from: 'gemini',
        to: 'groq',
      }));
    }

    const committed = await subscriptionUsageService.commitChatMessage(req.userId, reservation.reservationId);
    if (!committed.committed) {
      throw Object.assign(new Error('AI message usage could not be recorded.'), {
        code: 'CHAT_USAGE_COMMIT_FAILED',
        statusCode: 503,
      });
    }
    usageCommitted = true;
    res.json({ success: true, data: { text: result.text, raw: result.raw } });
  } catch (err) {
    if (reservation?.reservationId && !usageCommitted) {
      try {
        await subscriptionUsageService.releaseChatReservation(req.userId, reservation.reservationId);
      } catch (releaseError) {
        console.error('[CHAT_RESERVATION_RELEASE_FAILED]', releaseError?.name || releaseError?.code || 'UsageError');
      }
    }
    return next(err);
  }
}

module.exports = { generateTextController, shouldFallbackToGroq };
