const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const authRoutes = require('./routes/authRoutes');
const profileRoutes = require('./routes/profileRoutes');
const passwordRoutes = require('./routes/passwordRoutes');
const aiRoutes = require('./routes/aiRoutes');
const memoryRoutes = require('./routes/memoryRoutes');
const liveRoutes = require('./routes/liveRoutes');
const ttsRoutes = require('./routes/ttsRoutes');
const identityRoutes = require('./routes/identityRoutes');
const emailController = require('./controllers/emailController');
const security = require('./middleware/security');
const errorHandler = require('./middleware/errorHandler');
const { isAllowedCorsOrigin } = require('./config/env');

const createApp = () => {
  const app = express();
  security(app);

  // Start background gemini health poller so /auth/token health can be reported
  try {
    const geminiHealth = require('./services/geminiHealth');
    geminiHealth.startPoll();
  } catch (e) {
    console.warn('Failed to start gemini health poller', e);
  }

  app.use(cors({
    origin: (origin, callback) => {
      if (isAllowedCorsOrigin(origin)) {
        callback(null, true);
      } else {
        callback(new Error('CORS origin not allowed'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Accept',
      'Authorization',
      'Content-Type',
      'X-App-Version',
      'X-Client-Platform',
      'X-Requested-With',
    ],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  }));

  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: true }));

  app.use('/api/auth', authRoutes);
  app.use('/auth', authRoutes);
  app.use('/api/profile', profileRoutes);
  app.use('/api/password', passwordRoutes);
  app.use('/api/ai', aiRoutes);
  app.use('/api/memory', memoryRoutes);
  app.use('/api/live', liveRoutes);
  app.use('/api/identity', identityRoutes);
  app.use('/api/tts', ttsRoutes);

  app.get('/test-email', emailController.testEmail);
  app.get('/', (_req, res) => res.json({ success: true, message: 'API Running' }));
  app.get('/health', (_req, res) => res.json({ success: true, ok: true, message: 'API Running' }));
  app.get('/api/health', (_req, res) => res.json({ success: true, ok: true, message: 'API Running' }));

  app.use(errorHandler);
  return app;
};

module.exports = createApp;
