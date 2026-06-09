const { extractBearerToken } = require('./authCookies');

function resolveOptionalAuthUserId(req) {
  const bearerToken = extractBearerToken(req.headers && req.headers.authorization);
  return bearerToken ? undefined : undefined;
}

module.exports = { resolveOptionalAuthUserId };
