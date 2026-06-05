const path = require('path');
const dotenv = require('dotenv');

const configRoot = path.resolve(__dirname, '../../');
dotenv.config({ path: path.resolve(configRoot, '.env.local') });
dotenv.config({ path: path.resolve(configRoot, '.env') });

function readEnv(name, fallback = '') {
  return (process.env[name] || fallback).trim();
}

function readNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function readList(name, fallback) {
  const rawValue = (process.env[name] || '').trim();
  if (!rawValue) return fallback;
  return rawValue.split(',').map((v) => v.trim().replace(/\/$/, '')).filter(Boolean);
}

function mergeLists(...lists) {
  return Array.from(new Set(lists.flat().filter(Boolean)));
}

const defaultClientOrigins = [
  'http://localhost:5173',
  'http://localhost:8081',
  'http://localhost:8100',
  'http://localhost:19006',
  'http://localhost',
  'https://localhost',
  'https://localhost:8100',
  'capacitor://localhost',
  'ionic://localhost',
];

const defaultNativeClientOriginSchemes = [
  'capacitor',
  'ionic',
];

const env = {
  clientOrigins: mergeLists(
    defaultClientOrigins,
    readList('CLIENT_ORIGIN', [])
  ),
  nativeClientOriginSchemes: mergeLists(
    defaultNativeClientOriginSchemes,
    readList('NATIVE_CLIENT_ORIGIN_SCHEMES', [])
  ),
  elevenLabsApiKey: readEnv('ELEVENLABS_API_KEY'),
  elevenLabsVoiceId: readEnv('ELEVENLABS_VOICE_ID'),
  geminiApiKey: readEnv('GEMINI_API_KEY'),
  geminiLiveModel: readEnv('GEMINI_LIVE_MODEL', ''),
  geminiLiveVoice: readEnv('GEMINI_LIVE_VOICE', ''),
  jwtSecret: readEnv('JWT_SECRET', 'dev-only-change-me'),
  jwtAccessSecret: readEnv('JWT_ACCESS_SECRET', ''),
  jwtRefreshSecret: readEnv('JWT_REFRESH_SECRET', ''),
  googleClientId: readEnv('GOOGLE_CLIENT_ID', ''),
  emailFrom: readEnv('EMAIL_FROM', 'no-reply@example.com'),
  emailTransportUrl: readEnv('EMAIL_TRANSPORT_URL', ''),
  cookieDomain: readEnv('COOKIE_DOMAIN', ''),
  aesSecret: readEnv('AES_SECRET', 'aes-secret-32-bytes-length!!'),
  mongoUri: readEnv('MONGODB_URI', 'mongodb://127.0.0.1:27017/kiara_ai'),
  nodeEnv: readEnv('NODE_ENV', 'development'),
  port: readNumber('PORT', 4000),
  // Redis Configuration for Short-term Memory
  redisHost: readEnv('REDIS_HOST', 'localhost'),
  redisPort: readNumber('REDIS_PORT', 6379),
  redisDb: readNumber('REDIS_DB', 0),
  redisPassword: readEnv('REDIS_PASSWORD', ''),
  // Memory TTL Configuration
  shortTermMemoryTTL: readNumber('SHORT_TERM_MEMORY_TTL', 3600), // 1 hour
};

function isProductionEnv() {
  return env.nodeEnv === 'production';
}

function isNativeAppOrigin(origin) {
  try {
    const parsedOrigin = new URL(origin);
    const protocol = parsedOrigin.protocol.replace(':', '');
    return (
      env.nativeClientOriginSchemes.includes(protocol) &&
      (parsedOrigin.hostname === 'localhost' || parsedOrigin.hostname === '')
    );
  } catch {
    return false;
  }
}

function isAllowedCorsOrigin(origin) {
  if (!origin || origin === 'null') return true;
  const normalizedOrigin = origin.trim().replace(/\/$/, '');
  return env.clientOrigins.includes(normalizedOrigin) || isNativeAppOrigin(normalizedOrigin);
}

module.exports = { env, isProductionEnv, isAllowedCorsOrigin, isNativeAppOrigin };
