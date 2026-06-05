const { env, isProductionEnv } = require('../config/env');

function errorHandler(err, req, res, next) {
  console.error(err);
  const status = err.status || 500;
  const response = { success: false, message: err.message || 'Server error' };
  if (!isProductionEnv()) {
    response.error = { stack: err.stack };
  }
  res.status(status).json(response);
}

module.exports = errorHandler;
