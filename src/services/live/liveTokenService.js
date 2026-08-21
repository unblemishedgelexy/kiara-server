const { createLiveEphemeralToken: createGeminiLiveToken } = require('./geminiService');

async function createLiveEphemeralToken(requestingUserId = null, options = {}) {
  try {
    return await createGeminiLiveToken(requestingUserId, options);
  } catch (error) {
    console.error('[ERROR]', 'createLiveEphemeralToken failed:', error instanceof Error ? error.message : error);
    throw new Error(error instanceof Error ? error.message : 'Failed to create live ephemeral token');
  }
}

module.exports = { createLiveEphemeralToken };
