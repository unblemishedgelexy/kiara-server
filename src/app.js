const express = require('express');
const bodyParser = require('body-parser');
const { randomUUID } = require('crypto');
const cors = require('cors');
const authRoutes = require('./routes/authRoutes');
const profileRoutes = require('./routes/profileRoutes');
const passwordRoutes = require('./routes/passwordRoutes');
const aiRoutes = require('./routes/aiRoutes');
const liveRoutes = require('./routes/liveRoutes');
const ttsRoutes = require('./routes/ttsRoutes');
const identityRoutes = require('./routes/identityRoutes');
const workingMemoryRoutes = require('./routes/workingMemory.routes');
const emailController = require('./controllers/emailController');
const security = require('./middleware/security');
const errorHandler = require('./middleware/errorHandler');
const { env, isAllowedCorsOrigin } = require('./config/env');

const createApp = () => {
  const app = express();
  security(app);

  app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedCorsOrigin(origin)) {
        callback(null, true);
      } else {
        callback(new Error("CORS origin not allowed"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Accept",
      "Authorization",
      "Content-Type",
      "X-App-Version",
      "X-Client-Platform",
      "X-Memory-Trace-Id",
      "X-Request-Id",
      "X-Requested-With",
      "X-Refresh-Token", // ✅ Add this
    ],
    exposedHeaders: [
      "X-Memory-Trace-Id",
      "X-Request-Id",
    ],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  })
);

  app.use((req, res, next) => {
    try {
      req.requestId = typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].trim()
        ? req.headers['x-request-id'].trim()
        : randomUUID();
    } catch {
      req.requestId = randomUUID();
    }

    try {
      req.memoryTraceId = typeof req.headers['x-memory-trace-id'] === 'string' && req.headers['x-memory-trace-id'].trim()
        ? req.headers['x-memory-trace-id'].trim()
        : `memtrace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    } catch {
      req.memoryTraceId = `memtrace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }

    req.rawBody = '';
    res.setHeader('X-Request-Id', req.requestId);
    res.setHeader('X-Memory-Trace-Id', req.memoryTraceId);
    next();
  });

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
  app.use('/api/password', passwordRoutes);
  app.use('/api/ai', aiRoutes);
  app.use('/api/live', liveRoutes);
  app.use('/api/identity', identityRoutes);
  app.use('/api/tts', ttsRoutes);
  app.use('/api/working-memory', workingMemoryRoutes);

  // Development-only performance routes
  try {
    const devPerf = require('./routes/devPerfRoutes');
    app.use('/api/dev', devPerf);
  } catch (e) {
    // ignore if not present
  }

  // Debug runtime endpoints
  try {
    const debugRoutes = require('./routes/debugRoutes');
    app.use('/debug', debugRoutes);
  } catch (e) {
    console.error('[ERROR]', 'Failed to mount debug routes:', e && e.message ? e.message : e);
  }

  app.get('/test-email', emailController.testEmail);
  app.get('/', (_req, res) => res.json({ success: true, message: 'API Running' }));
  app.get('/health', (_req, res) => res.json({ success: true, ok: true, message: 'API Running' }));
  app.get('/api/health', (_req, res) => res.json({ success: true, ok: true, message: 'API Running' }));

  app.use(errorHandler);
  return app;
};

module.exports = createApp;
