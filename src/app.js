const express = require('express');
const bodyParser = require('body-parser');
const { randomUUID } = require('crypto');
const cors = require('cors');
const authRoutes = require('./routes/authRoutes');
const profileRoutes = require('./routes/profileRoutes');
const subscriptionRoutes = require('./routes/subscriptionRoutes');
const passwordRoutes = require('./routes/passwordRoutes');
const aiRoutes = require('./routes/aiRoutes');
const liveRoutes = require('./routes/liveRoutes');
const ttsRoutes = require('./routes/ttsRoutes');
const identityRoutes = require('./routes/identityRoutes');
const workingMemoryRoutes = require('./routes/workingMemory.routes');
const adminRoutes = require('./routes/adminRoutes');
const security = require('./middleware/security');
const errorHandler = require('./middleware/errorHandler');
const { env, isAllowedCorsOrigin } = require('./config/env');
const mongoose = require('mongoose');
const { getRedisClient, getRedisDiagnostics } = require('./services/infrastructure/redisService');
const redisAbuseProtection = require('./middleware/redisAbuseProtection');

function withTimeout(promise, timeoutMs) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Readiness check timed out')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

const createApp = () => {
  const app = express();

  app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedCorsOrigin(origin)) {
        callback(null, true);
      } else {
        callback(new Error("CORS origin not allowed"));
      }
    },
    credentials: false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Accept",
      "Authorization",
      "Content-Type",
      "X-App-Version",
      "X-Client-Platform",
      "X-Kiara-Trace-Id",
      "X-Memory-Trace-Id",
      "X-Request-Id",
      "X-Kiara-Trigger",
      "X-Requested-With",
      "X-Refresh-Token",
    ],
    exposedHeaders: [
      "X-Memory-Trace-Id",
      "X-Request-Id",
    ],
    maxAge: 86400,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  })
);

  security(app);

  app.use((req, res, next) => {
    try {
      req.requestId = typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].trim()
        ? req.headers['x-request-id'].trim()
        : randomUUID();
    } catch {
      req.requestId = randomUUID();
    }

    req.rawBody = '';
    res.setHeader('X-Request-Id', req.requestId);
    req.lifecycleTrigger = typeof req.headers['x-kiara-trigger'] === 'string' && req.headers['x-kiara-trigger'].trim()
      ? req.headers['x-kiara-trigger'].trim()
      : 'USER_ACTION';
    next();
  });

  const authAdmission = redisAbuseProtection({
    scope: 'ip',
    bucket: 'auth-v2',
    maxInFlightPerIp: env.authAbuseMaxInFlightPerIp,
    burstMax: env.authAbuseBurstMax,
    burstWindowSeconds: env.authAbuseBurstWindowSeconds,
    blockSeconds: env.authAbuseBlockSeconds,
    leaseSeconds: env.authAbuseLeaseSeconds,
  });
  const apiAdmission = redisAbuseProtection({
    scope: 'ip',
    bucket: 'api',
    skip: (req) => {
      const originalPath = String(req.originalUrl || req.path).split('?')[0];
      const isRouteWithDedicatedAdmission = /^\/(?:api\/)?(?:auth|identity)(?:\/|$)/i.test(originalPath)
        || /^\/(?:api\/)?live\/token$/i.test(originalPath)
        || /^\/api\/(?:profile|subscriptions)(?:\/|$)/i.test(originalPath);
      return isRouteWithDedicatedAdmission
        || ['/health', '/readyz', '/live/health', '/live/health/check'].includes(req.path);
    },
  });
  app.use('/api', apiAdmission);
  app.use('/api/auth', authAdmission);
  app.use('/auth', authAdmission);

  app.use(bodyParser.json({
    verify: (req, _res, buf, encoding) => {
      if (buf && buf.length) {
        req.rawBody = buf.toString(encoding || 'utf-8');
      }
    },
  }));
  app.use(bodyParser.urlencoded({
    extended: true,
    verify: (req, _res, buf, encoding) => {
      if (buf && buf.length) {
        req.rawBody = buf.toString(encoding || 'utf-8');
      }
    },
  }));

  app.use('/api/auth', authRoutes);
  app.use('/auth', authRoutes);
  app.use('/api/profile', profileRoutes); 
  app.use('/api/subscriptions', subscriptionRoutes);
  app.use('/api/password', passwordRoutes);
  app.use('/api/ai', aiRoutes);
  app.use('/api/live', liveRoutes);
  app.use('/api/identity', identityRoutes);
  app.use('/api/tts', ttsRoutes);
  app.use('/api/working-memory', workingMemoryRoutes);
  app.use('/api', adminRoutes);

  if (env.nodeEnv !== 'production') {
    app.use('/api/dev', require('./routes/devPerfRoutes'));
    app.use('/debug', require('./routes/debugRoutes'));
  }

  app.get('/', (_req, res) => res.json({ success: true, message: 'API Running' }));
  app.get('/health', (_req, res) => res.json({ success: true, ok: true, message: 'API Running' }));
  app.get('/api/health', (_req, res) => res.json({ success: true, ok: true, message: 'API Running' }));
  const readinessHandler = async (_req, res) => {
    let redisReady = false;
    let redisFailureCode = null;
    try {
      const client = await withTimeout(getRedisClient(), 1500);
      redisReady = (await withTimeout(client.ping(), 1000)) === 'PONG';
    } catch (error) {
      redisReady = false;
      redisFailureCode = error?.code || error?.name || 'readiness_error';
    }
    const dependencies = {
      mongodb: mongoose.connection.readyState === 1,
      redis: redisReady,
    };
    const ready = Object.values(dependencies).every(Boolean);
    const response = {
      success: ready,
      ready,
      dependencies,
    };
    if (env.nodeEnv !== 'production') {
      response.diagnostics = {
        redis: {
          ...getRedisDiagnostics(),
          readinessFailureCode: redisFailureCode,
        },
      };
    }
    return res.status(ready ? 200 : 503).json(response);
  };
  app.get('/readyz', readinessHandler);
  app.get('/api/readyz', readinessHandler);

  app.use(errorHandler);
  return app;
};

module.exports = createApp;
