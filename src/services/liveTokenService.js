const { createLiveEphemeralToken: createGeminiLiveToken } = require('./geminiService');

async function createLiveEphemeralToken(requestingUserId = null) {
  return createGeminiLiveToken(requestingUserId);
}

module.exports = { createLiveEphemeralToken };
