const { verifyAccessToken } = require('../services/tokenService');
const { extractBearerToken } = require('../utils/authCookies');

function authMiddleware(req, res, next) {
  const cookieToken = req.cookies?.accessToken;
  const authHeader = req.headers.authorization || '';
  const bearerToken = extractBearerToken(authHeader);
  const token = cookieToken || bearerToken;

  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }

  try {
    const payload = verifyAccessToken(token);
    req.userId = payload.sub;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }
}

module.exports = authMiddleware;
