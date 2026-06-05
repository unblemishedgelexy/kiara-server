const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { env } = require('../config/env');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.nodeEnv === 'development' ? 1000 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

module.exports = function (app) {
  app.use(helmet());

  if (env.nodeEnv === 'production') {
    app.set('trust proxy', 1);
    app.use(limiter);
  }
};
