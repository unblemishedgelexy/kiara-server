const path = require('path');
const {
  GEMINI_LIVE_MODEL,
  GEMINI_LIVE_SYSTEM_INSTRUCTION,
  GEMINI_LIVE_VOICE,
} = require('../../config/constants');

let capabilityRegistry = null;
try {
  capabilityRegistry = require(path.resolve(__dirname, '../../../../Kiara-ai/worker/src/capabilityRegistry.js')).capabilityRegistry || null;
} catch {
  capabilityRegistry = null;
}

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
    : GEMINI_LIVE_MODEL;
}

function normalizeLiveVoice(voiceName) {
  return (
    voiceByLowercase.get(String(voiceName || '').trim().toLowerCase()) ||
    GEMINI_LIVE_VOICE
  );
}

function createLiveSessionConfig(options = {}) {
  const requestedModel = options.model || GEMINI_LIVE_MODEL;
  const requestedVoice = options.voiceName || GEMINI_LIVE_VOICE;
  const model = normalizeLiveModel(requestedModel);
  const voiceName = normalizeLiveVoice(requestedVoice);

  return {
    model,
    responseModalities: ['AUDIO'],
    systemInstruction: options.systemInstruction || GEMINI_LIVE_SYSTEM_INSTRUCTION,
    voiceName,
  };
}

function normalizeParameterType(value) {
  if (Array.isArray(value)) {
    return 'ARRAY';
  }
  if (value && typeof value === 'object') {
    return 'OBJECT';
  }
  return 'STRING';
}

function capabilityRegistryToFunctionDeclarations(registry) {
  const capabilities = Array.isArray(registry?.capabilities) ? registry.capabilities : [];
  return capabilities.map((capability) => {
    const params = capability?.args && typeof capability.args === 'object' ? capability.args : {};
    const required = Array.isArray(capability?.requiredArguments) ? capability.requiredArguments : [];
    const optional = Array.isArray(capability?.optionalArguments) ? capability.optionalArguments : [];
    const allParameterKeys = Array.from(new Set([...Object.keys(params), ...required, ...optional]));
    const properties = {};
    allParameterKeys.forEach((key) => {
      const value = params[key];
      properties[key] = {
        type: normalizeParameterType(value),
        description: typeof value === 'string' ? value : 'Capability argument',
      };
    });

    return {
      name: String(capability?.name || '').trim(),
      description: String(capability?.purpose || capability?.description || ''),
      parameters: {
        type: 'OBJECT',
        properties,
        required: allParameterKeys.filter((key) => required.includes(key)),
      },
    };
  }).filter((tool) => Boolean(tool.name));
}

function createGeminiToolsFromCapabilityRegistry(registry = capabilityRegistry) {
  const functionDeclarations = capabilityRegistryToFunctionDeclarations(registry);
  if (!functionDeclarations.length) {
    return [];
  }

  return [
    {
      functionDeclarations,
    },
  ];
}

function createPublicLiveSessionConfig(sessionConfig) {
  return {
    model: sessionConfig.model,
    responseModalities: sessionConfig.responseModalities,
    systemInstruction: sessionConfig.systemInstruction,
    tools: createGeminiToolsFromCapabilityRegistry(),
    voiceName: sessionConfig.voiceName,
  };
}

function createLiveConnectConfig(sessionConfig) {
  const tools = createGeminiToolsFromCapabilityRegistry();
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
    tools,
  };
}

module.exports = {
  SUPPORTED_GEMINI_LIVE_MODELS,
  SUPPORTED_GEMINI_LIVE_VOICES,
  createLiveConnectConfig,
  createPublicLiveSessionConfig,
  createLiveSessionConfig,
  createGeminiToolsFromCapabilityRegistry,
  capabilityRegistryToFunctionDeclarations,
};
