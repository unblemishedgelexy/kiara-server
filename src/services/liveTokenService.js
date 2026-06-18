const { createLiveEphemeralToken: createGeminiLiveToken } = require('./geminiService');

async function createLiveEphemeralToken(requestingUserId = null) {
  try {
    return await createGeminiLiveToken(requestingUserId);
  } catch (error) {
    console.error('[LiveTokenService] createLiveEphemeralToken error', error);
    throw new Error(error instanceof Error ? error.message : 'Failed to create live ephemeral token');
  }
}

module.exports = { createLiveEphemeralToken };
