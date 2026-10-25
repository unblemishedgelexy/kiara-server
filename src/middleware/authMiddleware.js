const { verifyAccessToken } = require('../services/../services/auth/tokenService');
const { extractBearerToken } = require('../utils/authCookies');
const UserModel = require('../models/User');

function readRequestToken(req) {
  const authHeader = req.headers.authorization || '';
  const bearerToken = extractBearerToken(authHeader);
  return bearerToken || req.headers['x-access-token'];
}

function attachAuthUser(req, payload) {
  const userId = payload.sub || payload.userId || payload.id;
  req.userId = typeof userId === 'object' && userId !== null && userId.id ? userId.id : userId;
}

async function authMiddleware(req, res, next) {
  const token = readRequestToken(req);

  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }

  attachAuthUser(req, payload);
  try {
    const user = await UserModel.findById(req.userId).select('isActive').lean();
    if (!user || !user.isActive) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_INACTIVE',
        message: 'This account is inactive. Sign in within the 10-day deletion period to reactivate it.',
      });
    }
  } catch (error) {
    return next(error);
  }

  return next();
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
