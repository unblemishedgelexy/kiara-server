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
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'script-src': ["'self'", 'https://checkout.razorpay.com'],
        'frame-src': ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
        'connect-src': ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
      },
    },
  }));

  if (env.nodeEnv === 'production') {
    app.set('trust proxy', 1);
    app.use(limiter);
  }
};
