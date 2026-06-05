const {
  GEMINI_LIVE_MODEL,
  GEMINI_LIVE_SYSTEM_INSTRUCTION,
  GEMINI_LIVE_VOICE,
} = require('../config/constants');

const DEFAULT_GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
const DEFAULT_GEMINI_LIVE_VOICE = 'Leda';

const SUPPORTED_GEMINI_LIVE_MODELS = new Set([
  'gemini-3.1-flash-live-preview',
  'gemini-2.5-flash-native-audio-preview-12-2025',
  'gemini-2.5-flash-preview-native-audio-dialog',
  'gemini-2.0-flash-live-001',
  'gemini-2.0-flash-live-preview-04-09',
]);

const SUPPORTED_GEMINI_LIVE_VOICES = [
  'Zephyr',
  'Puck',
  'Charon',
  'Kore',
  'Fenrir',
  'Leda',
  'Orus',
  'Aoede',
  'Callirrhoe',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Erinome',
  'Algenib',
  'Rasalgethi',
  'Laomedeia',
  'Achernar',
  'Alnilam',
  'Schedar',
  'Gacrux',
  'Pulcherrima',
  'Achird',
  'Zubenelgenubi',
  'Vindemiatrix',
  'Sadachbia',
  'Sadaltager',
  'Sulafat',
];

const voiceByLowercase = new Map(
  SUPPORTED_GEMINI_LIVE_VOICES.map((voiceName) => [
    voiceName.toLowerCase(),
    voiceName,
  ])
);

function normalizeLiveModel(model) {
  const requestedModel = String(model || '').trim();
  return SUPPORTED_GEMINI_LIVE_MODELS.has(requestedModel)
    ? requestedModel
    : DEFAULT_GEMINI_LIVE_MODEL;
}

function normalizeLiveVoice(voiceName) {
  return (
    voiceByLowercase.get(String(voiceName || '').trim().toLowerCase()) ||
    DEFAULT_GEMINI_LIVE_VOICE
  );
}

function createLiveSessionConfig(options = {}) {
  const requestedModel = options.model || GEMINI_LIVE_MODEL;
  const requestedVoice = options.voiceName || GEMINI_LIVE_VOICE;
  const model = normalizeLiveModel(requestedModel);
  const voiceName = normalizeLiveVoice(requestedVoice);

  if (requestedModel !== model) {
    console.warn(`Unsupported Gemini Live model "${requestedModel}". Using "${model}".`);
  }

  if (requestedVoice !== voiceName) {
    console.warn(`Unsupported Gemini Live voice "${requestedVoice}". Using "${voiceName}".`);
  }

  return {
    model,
    responseModalities: ['AUDIO'],
    systemInstruction: options.systemInstruction || GEMINI_LIVE_SYSTEM_INSTRUCTION,
    voiceName,
  };
}

function createPublicLiveSessionConfig(sessionConfig) {
  return {
    model: sessionConfig.model,
    responseModalities: sessionConfig.responseModalities,
    voiceName: sessionConfig.voiceName,
  };
}

function createLiveConnectConfig(sessionConfig) {
  return {
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false,
        endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
        prefixPaddingMs: 120,
        silenceDurationMs: 420,
        startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
      },
      activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
      turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY',
    },
    responseModalities: sessionConfig.responseModalities,
    sessionResumption: {},
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: sessionConfig.voiceName,
        },
      },
    },
    systemInstruction: sessionConfig.systemInstruction,
    temperature: 0.7,
  };
}

module.exports = {
  SUPPORTED_GEMINI_LIVE_MODELS,
  SUPPORTED_GEMINI_LIVE_VOICES,
  createLiveConnectConfig,
  createPublicLiveSessionConfig,
  createLiveSessionConfig,
};
