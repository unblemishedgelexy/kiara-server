const { Readable } = require('stream');
const { env } = require('../../config/env');

async function streamElevenLabsSpeech(text) {
  if (!env.elevenLabsApiKey || !env.elevenLabsVoiceId) {
    throw new Error('ElevenLabs API not configured');
  }

  const body = Readable.from([]);
  return {
    headers: new Map([['content-type', 'audio/mpeg']]),
    body,
  };
}

module.exports = { streamElevenLabsSpeech };
