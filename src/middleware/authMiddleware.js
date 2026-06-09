const { verifyAccessToken } = require('../services/tokenService');
const { extractBearerToken } = require('../utils/authCookies');

function readRequestToken(req) {
  const authHeader = req.headers.authorization || '';
  const bearerToken = extractBearerToken(authHeader);
  return bearerToken || req.headers['x-access-token'];
}

function attachAuthUser(req, payload) {
  const userId = payload.sub || payload.userId || payload.id;
  req.userId = typeof userId === 'object' && userId !== null && userId.id ? userId.id : userId;
}

function authMiddleware(req, res, next) {
  const token = readRequestToken(req);

  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }

  try {
    const payload = verifyAccessToken(token);
    attachAuthUser(req, payload);
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }
}

function optionalAuthMiddleware(req, _res, next) {
  const token = readRequestToken(req);

  if (!token) {
    next();
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    attachAuthUser(req, payload);
  } catch {
    req.userId = undefined;
  }

  next();
}

authMiddleware.optional = optionalAuthMiddleware;

module.exports = authMiddleware;
