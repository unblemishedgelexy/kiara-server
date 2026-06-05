const { createLiveEphemeralToken: createGeminiLiveToken } = require('./geminiService');

async function createLiveEphemeralToken() {
  return createGeminiLiveToken();
}

module.exports = { createLiveEphemeralToken };
