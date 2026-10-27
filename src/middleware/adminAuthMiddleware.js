const { verifyAccessToken } = require('../services/auth/tokenService');
const { extractBearerToken } = require('../utils/authCookies');

function readRequestToken(req) {
  const bearerToken = extractBearerToken(req.headers.authorization || '');
  return bearerToken || req.headers['x-access-token'];
}

function adminAuthMiddleware(req, res, next) {
  const token = readRequestToken(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'Admin authentication required.' });
  }

  try {
    const payload = verifyAccessToken(token);
    if (payload.tokenType !== 'admin' || !payload.sub) {
      return res.status(401).json({ success: false, message: 'Invalid admin access token.' });
    }
    req.userId = payload.sub;
    req.adminId = payload.sub;
    return next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired admin token.' });
  }
}

module.exports = adminAuthMiddleware;
