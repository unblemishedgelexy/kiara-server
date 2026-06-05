const { AUTH_COOKIE_NAME, extractBearerToken, verifySessionToken } = require('./authCookies');

function resolveOptionalAuthUserId(req) {
  const cookieToken = req.cookies && req.cookies[AUTH_COOKIE_NAME];
  const bearerToken = extractBearerToken(req.headers && req.headers.authorization);
  const token = cookieToken || bearerToken;
  if (!token) return undefined;
  try {
    return verifySessionToken(token).userId;
  } catch (err) {
    return undefined;
  }
}

module.exports = { resolveOptionalAuthUserId };
