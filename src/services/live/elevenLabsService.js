const { env } = require('../../config/env');
const {
  ELEVENLABS_OUTPUT_FORMAT,
  ELEVENLABS_STREAM_LATENCY,
  ELEVENLABS_TTS_MODEL,
  ELEVENLABS_VOICE_SETTINGS,
} = require('../../config/constants');

async function streamElevenLabsSpeech(text) {
  if (!env.elevenLabsApiKey || !env.elevenLabsVoiceId) {
    return null;
  }

  const voiceId = encodeURIComponent(env.elevenLabsVoiceId);
  const query = new URLSearchParams({
    output_format: ELEVENLABS_OUTPUT_FORMAT,
    optimize_streaming_latency: String(ELEVENLABS_STREAM_LATENCY),
  });

  return fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?${query.toString()}`,
    {
      method: 'POST',
      headers: {
        Accept: 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': env.elevenLabsApiKey,
      },
      body: JSON.stringify({
        text,
        model_id: ELEVENLABS_TTS_MODEL,
        voice_settings: ELEVENLABS_VOICE_SETTINGS,
      }),
    }
  );
}

module.exports = { streamElevenLabsSpeech };
