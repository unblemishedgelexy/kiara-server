const path = require('path');
const dotenv = require('dotenv');

const configRoot = path.resolve(__dirname, '../../');
dotenv.config({ path: path.resolve(configRoot, '.env.local'), quiet: true });
dotenv.config({ path: path.resolve(configRoot, '.env'), quiet: true });

function stripQuotes(value) {
  if (typeof value !== 'string') return value;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function readEnv(name, fallback = '') {
  return stripQuotes((process.env[name] || fallback).trim());
}

function readNumber(name, fallback) {
  const value = Number(stripQuotes(process.env[name]));
  return Number.isFinite(value) ? value : fallback;
}

function readPositiveNumber(name, fallback) {
  const value = readNumber(name, fallback);
  return value > 0 ? value : fallback;
}

function readList(name, fallback) {
  const rawValue = stripQuotes((process.env[name] || '').trim());
  if (!rawValue) return fallback;
  return rawValue.split(',').map((v) => stripQuotes(v.trim().replace(/\/$/, ''))).filter(Boolean);
}

function readTrustProxy() {
  const value = readEnv('TRUST_PROXY', nodeEnv === 'production' ? '1' : 'false').toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function mergeLists(...lists) {
  return Array.from(new Set(lists.flat().filter(Boolean)));
}

const defaultClientOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:8081',
  'http://localhost:8100',
  'http://localhost:19006',
  'http://localhost',
  'https://localhost',
  'https://localhost:8100',
  'capacitor://localhost',
  'ionic://localhost',
];

const nodeEnv = readEnv('NODE_ENV', 'development');
const isNodeTest = process.env.NODE_TEST_CONTEXT === 'child-v8' || nodeEnv === 'test';

const env = {
  allowedOrigins: mergeLists(
    readList('ALLOWED_ORIGINS', []),
    [
      'https://kiaraai.netlify.app',
      'http://localhost:5173',
      'http://localhost:5174',
    ],
    readList('CLIENT_ORIGIN', defaultClientOrigins),
    nodeEnv === 'production' ? [] : [
      'http://localhost:5173',
      'http://localhost:5174',
      'http://127.0.0.1:5173',
      'http://127.0.0.1:5174',
    ]
  ),
  elevenLabsApiKey: readEnv('ELEVENLABS_API_KEY'),
  elevenLabsVoiceId: readEnv('ELEVENLABS_VOICE_ID'),
  geminiApiKey: readEnv('GEMINI_API_KEY'),
  groqApiKey: readEnv('GROQ_API_KEY'),
  groqTextFallbackEnabled: readEnv('GROQ_TEXT_FALLBACK_ENABLED', 'false').toLowerCase() === 'true',
  geminiLiveModel: readEnv('GEMINI_LIVE_MODEL', ''),
  geminiLiveVoice: readEnv('GEMINI_LIVE_VOICE', ''),
  geminiEmbeddingModel: readEnv('GEMINI_EMBEDDING_MODEL', ''),
  jwtSecret: readEnv('JWT_SECRET', 'dev-only-change-me'),
  jwtAccessSecret: readEnv('JWT_ACCESS_SECRET', ''),
  jwtRefreshSecret: readEnv('JWT_REFRESH_SECRET', ''),
  serverUrl: readEnv('SERVER_URL', 'http://localhost:4000'),
  emailProvider: readEnv('EMAIL_PROVIDER', nodeEnv === 'production' ? 'ses' : 'discard').toLowerCase(),
  emailFrom: readEnv('EMAIL_FROM', ''),
  emailUser: readEnv('SMTP_USER', readEnv('EMAIL_USER', '')),
  emailPass: readEnv('SMTP_PASS', readEnv('EMAIL_PASS', '')),
  smtpHost: readEnv('SMTP_HOST', 'smtp.gmail.com'),
  smtpPort: readNumber('SMTP_PORT', 587),
  smtpSecure: readEnv('SMTP_SECURE', 'false').toLowerCase() === 'true',
  awsRegion: readEnv('AWS_REGION', ''),
  awsSesFromEmail: readEnv('AWS_SES_FROM_EMAIL', ''),
  smsTransportUrl: readEnv('SMS_TRANSPORT_URL', ''),
  twilioAccountSid: readEnv('TWILIO_ACCOUNT_SID', ''),
  twilioAuthToken: readEnv('TWILIO_AUTH_TOKEN', ''),
  twilioFromNumber: readEnv('TWILIO_FROM_NUMBER', ''),
  cookieDomain: readEnv('COOKIE_DOMAIN', ''),
  googleClientId: readEnv('GOOGLE_CLIENT_ID', ''),
  googleClientSecret: readEnv('GOOGLE_CLIENT_SECRET', ''),
  googleOAuthRedirectUri: readEnv('GOOGLE_OAUTH_REDIRECT_URI', `${process.env.SERVER_URL || 'http://localhost:4000'}/api/auth/google/callback`),
  adminRegistrationKey: readEnv('ADMIN_REGISTRATION_KEY', ''),
  googleAuthAllowedReturnUrls: mergeLists(
    readList('ALLOWED_OAUTH_RETURN_URLS', []),
    [
      readEnv('APP_DEEP_LINK_URI', 'com.kiara.ai://auth-complete'),
      readEnv('WEB_AUTH_RETURN_URL', 'http://localhost:5173/auth/callback'),
      ...(nodeEnv !== 'production' ? ['http://localhost:5174'] : []),
    ]
  ),
  aesSecret: readEnv('AES_SECRET', 'aes-secret-32-bytes-length!!'),
  mongoUri: readEnv('MONGODB_URI', 'mongodb://127.0.0.1:27017/kiara_ai'),
  nodeEnv,
  localDevAuthEnabled: nodeEnv === 'development' && readEnv('LOCAL_DEV_AUTH_ENABLED', 'false').toLowerCase() === 'true',
  localDevSubscriptionBypass: nodeEnv === 'development' && readEnv('LOCAL_DEV_SUBSCRIPTION_BYPASS', 'false').toLowerCase() === 'true',
  port: readNumber('PORT', 4000),
  trustProxy: readTrustProxy(),
  abuseMaxInFlightPerIp: readPositiveNumber('ABUSE_MAX_IN_FLIGHT_PER_IP', 20),
  abuseMaxInFlightPerAccount: readPositiveNumber('ABUSE_MAX_IN_FLIGHT_PER_ACCOUNT', 10),
  abuseBurstMax: readPositiveNumber('ABUSE_BURST_MAX', 120),
  abuseBurstWindowSeconds: readPositiveNumber('ABUSE_BURST_WINDOW_SECONDS', 10),
  abuseBlockSeconds: readPositiveNumber('ABUSE_BLOCK_SECONDS', 30),
  abuseLeaseSeconds: readPositiveNumber('ABUSE_LEASE_SECONDS', 120),
  authAbuseMaxInFlightPerIp: readPositiveNumber('AUTH_ABUSE_MAX_IN_FLIGHT_PER_IP', 20),
  authAbuseBurstMax: readPositiveNumber('AUTH_ABUSE_BURST_MAX', 120),
  authAbuseBurstWindowSeconds: readPositiveNumber('AUTH_ABUSE_BURST_WINDOW_SECONDS', 10),
  authAbuseBlockSeconds: readPositiveNumber('AUTH_ABUSE_BLOCK_SECONDS', 30),
  authAbuseLeaseSeconds: readPositiveNumber('AUTH_ABUSE_LEASE_SECONDS', 120),
  maxActiveLiveSessionsPerAccount: readPositiveNumber('MAX_ACTIVE_LIVE_SESSIONS_PER_ACCOUNT', 2),
  // Redis Configuration for Short-term Memory
  redisHost: readEnv('REDIS_HOST', 'localhost'),
  redisPort: readNumber('REDIS_PORT', 6379),
  redisDb: readNumber('REDIS_DB', 0),
  redisUrl: readEnv('REDIS_URL', ''),
  redisPassword: readEnv('REDIS_PASSWORD', ''),
  liveMemoryEnabled: readEnv('LIVE_MEMORY_ENABLED', 'true').toLowerCase() === 'true',
  memoryRetrievalSourceTimeoutMs: readPositiveNumber('MEMORY_RETRIEVAL_SOURCE_TIMEOUT_MS', 10000),
  memoryRetrievalTimeoutMs: readPositiveNumber('MEMORY_RETRIEVAL_TIMEOUT_MS', 10000),
  liveMemoryRetrievalTimeoutMs: readPositiveNumber('LIVE_MEMORY_RETRIEVAL_TIMEOUT_MS', 5000),
  memoryMongoQueryTimeoutMs: readPositiveNumber('MEMORY_MONGO_QUERY_TIMEOUT_MS', 3000),
  memoryGroqQueryPlannerEnabled: nodeEnv === 'development' && !isNodeTest
    && readEnv('MEMORY_GROQ_QUERY_PLANNER_ENABLED', 'false').toLowerCase() === 'true',
  enablePinecone: readEnv('ENABLE_PINECONE', 'true').toLowerCase() === 'true',
  enableQueue: readEnv('ENABLE_QUEUE', 'true').toLowerCase() === 'true',
  certificationMode: readEnv('CERTIFICATION_MODE', 'false').toLowerCase() === 'true',
  enablePromotionWorker: readEnv('ENABLE_PROMOTION_WORKER', 'true').toLowerCase() === 'true',
  promotionWorkerLimit: readNumber('PROMOTION_WORKER_LIMIT', 20),
  enableProfileCache: readEnv('ENABLE_PROFILE_CACHE', 'true').toLowerCase() === 'true',
  enableUnfinishedContext: readEnv('ENABLE_UNFINISHED_CONTEXT', 'true').toLowerCase() === 'true',
  enableMemoryLab: readEnv('ENABLE_MEMORY_LAB', nodeEnv === 'production' ? 'false' : 'true').toLowerCase() === 'true',
  memoryCanonicalReadEnabled: readEnv('MEMORY_CANONICAL_READ_ENABLED', 'false').toLowerCase() === 'true',
  memoryCanonicalReadMode: readEnv('MEMORY_CANONICAL_READ_MODE', 'legacy').toLowerCase(),
  memoryCanonicalWriteMode: readEnv('MEMORY_CANONICAL_WRITE_MODE', 'legacy').toLowerCase(),
  bootstrapVersion: readNumber('BOOTSTRAP_VERSION', 1),
  // Memory TTL Configuration
  shortTermMemoryTTL: readNumber('SHORT_TERM_MEMORY_TTL', 1500), // 25 minutes
  memoryCacheTtlSeconds: readNumber('MEMORY_CACHE_TTL_SECONDS', 3600),
  // Short-term memory retrieval character budget (controls how many characters are returned)
  shortTermMemoryCharBudget: readNumber('SHORT_TERM_MEMORY_CHAR_BUDGET', 4000),
  pineconeApiKey: readEnv('PINECONE_API_KEY', ''),
  pineconeIndexName: readEnv('PINECONE_INDEX_NAME', 'kiara-long-term-memory'),
  pineconeVectorDimension: readNumber('PINECONE_VECTOR_DIMENSION', 1024),
  pineconeEnvironment: readEnv('PINECONE_ENVIRONMENT', ''),
  pineconeCloud: readEnv('PINECONE_CLOUD', ''),
  pineconeRegion: readEnv('PINECONE_REGION', ''),
  // ImageKit configuration
  imagekitPublicKey: readEnv('IMAGEKIT_PUBLIC_KEY', ''),
  imagekitPrivateKey: readEnv('IMAGEKIT_PRIVATE_KEY', ''),
  imagekitUrlEndpoint: readEnv('IMAGEKIT_URL_ENDPOINT', ''),
  imagekitFolder: readEnv('IMAGEKIT_FOLDER', '/profiles'),
  imagekitMaxApkSizeBytes: 25 * 1024 * 1024,
  r2AccountId: readEnv('R2_ACCOUNT_ID', ''),
  r2AccessKeyId: readEnv('R2_ACCESS_KEY_ID', ''),
  r2SecretAccessKey: readEnv('R2_SECRET_ACCESS_KEY', ''),
  r2BucketName: readEnv('R2_BUCKET_NAME', ''),
  r2PublicBaseUrl: readEnv('R2_PUBLIC_BASE_URL', ''),
  razorpayKeyId: readEnv('RAZORPAY_KEY_ID', ''),
  razorpayKeySecret: readEnv('RAZORPAY_KEY_SECRET', ''),
  razorpayWebhookSecret: readEnv('RAZORPAY_WEBHOOK_SECRET', ''),
  razorpayPlanStarterId: readEnv('RAZORPAY_PLAN_STARTER_ID', ''),
  razorpayPlanProId: readEnv('RAZORPAY_PLAN_PRO_ID', ''),
  razorpayPlanPremiumId: readEnv('RAZORPAY_PLAN_PREMIUM_ID', ''),
  razorpaySubscriptionTotalCount: readNumber('RAZORPAY_SUBSCRIPTION_TOTAL_COUNT', 120),
  subscriptionStarterPriceInr: readNumber('SUBSCRIPTION_STARTER_PRICE_INR', 199),
  subscriptionStarterLiveMinutes: readNumber('SUBSCRIPTION_STARTER_LIVE_MINUTES', 60),
  subscriptionStarterChatMessages: readNumber('SUBSCRIPTION_STARTER_CHAT_MESSAGES', 300),
  subscriptionProPriceInr: readNumber('SUBSCRIPTION_PRO_PRICE_INR', 299),
  subscriptionProLiveMinutes: readNumber('SUBSCRIPTION_PRO_LIVE_MINUTES', 180),
  subscriptionProChatMessages: readNumber('SUBSCRIPTION_PRO_CHAT_MESSAGES', 1000),
  subscriptionPremiumPriceInr: readNumber('SUBSCRIPTION_PREMIUM_PRICE_INR', 399),
  subscriptionPremiumLiveMinutes: readNumber('SUBSCRIPTION_PREMIUM_LIVE_MINUTES', 400),
  subscriptionPremiumChatMessages: readNumber('SUBSCRIPTION_PREMIUM_CHAT_MESSAGES', 2500),
};

function isProductionEnv() {
  return env.nodeEnv === 'production';
}

function validateProductionConfig() {
  if (!isProductionEnv()) return;

  const isPlaceholder = (value) => !value || /<[^>]+>|change[-_ ]?me|replace[-_ ]?me/i.test(value);
  const requiredValues = [
    ['MONGODB_URI', env.mongoUri, 'mongodb://127.0.0.1:27017/kiara_ai'],
    ['JWT_ACCESS_SECRET', env.jwtAccessSecret, ''],
    ['JWT_REFRESH_SECRET', env.jwtRefreshSecret, ''],
    ['AES_SECRET', env.aesSecret, 'aes-secret-32-bytes-length!!'],
  ];
  const missing = requiredValues
    .filter(([, value, fallback]) => isPlaceholder(value) || value === fallback)
    .map(([name]) => name);

  if (!isPlaceholder(env.jwtAccessSecret) && env.jwtAccessSecret.length < 32) {
    missing.push('JWT_ACCESS_SECRET (minimum 32 characters)');
  }
  if (!isPlaceholder(env.jwtRefreshSecret) && env.jwtRefreshSecret.length < 32) {
    missing.push('JWT_REFRESH_SECRET (minimum 32 characters)');
  }
  if (!isPlaceholder(env.aesSecret) && env.aesSecret.length < 32) {
    missing.push('AES_SECRET (minimum 32 characters)');
  }
  if (env.jwtAccessSecret && env.jwtAccessSecret === env.jwtRefreshSecret) {
    missing.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
  }
  if (!['ses', 'smtp', 'brevo'].includes(env.emailProvider)) {
    missing.push('EMAIL_PROVIDER (must be ses, smtp, or brevo)');
  }
  if (env.emailProvider === 'ses' && !env.awsRegion) missing.push('AWS_REGION');
  if (env.emailProvider === 'ses' && !(env.awsSesFromEmail || env.emailFrom)) {
    missing.push('AWS_SES_FROM_EMAIL or EMAIL_FROM');
  }
  if (env.emailProvider === 'smtp' && (!env.emailUser || !env.emailPass)) {
    missing.push('SMTP_USER and SMTP_PASS');
  }
  if (env.emailProvider === 'brevo' && !readEnv('BREVO_API_KEY')) {
    missing.push('BREVO_API_KEY');
  }

  if (missing.length) {
    throw new Error(`Invalid production configuration: ${missing.join(', ')}`);
  }
}

// Normalize a return URL for strict comparison when validating OAuth return targets
function normalizeReturnUrl(url) {
  if (!url) return '';
  return url.trim().replace(/\/$/, '');
}

function isAllowedOAuthReturnUrl(url) {
  try {
    const normalized = normalizeReturnUrl(url);
    const allowed = env.googleAuthAllowedReturnUrls.map(normalizeReturnUrl);

    if (allowed.includes(normalized)) {
      return true;
    }

    const parsed = new URL(url);
    if (allowed.includes(parsed.origin)) {
      return true;
    }

    return false;
  } catch (e) {
    return false;
  }
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
  return env.allowedOrigins.includes(normalizedOrigin) || isNativeAppOrigin(normalizedOrigin);
}

module.exports = {
  env,
  isProductionEnv,
  validateProductionConfig,
  isAllowedCorsOrigin,
  isNativeAppOrigin,
  isAllowedOAuthReturnUrl,
};
