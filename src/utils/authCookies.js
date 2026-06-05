const jwt = require('jsonwebtoken');
const { AUTH_COOKIE_NAME, JWT_EXPIRY } = require('../config/constants');
const { env, isProductionEnv } = require('../config/env');

function createSessionToken(userId) {
  return jwt.sign({ userId }, env.jwtSecret, { expiresIn: JWT_EXPIRY });
}

function verifySessionToken(token) {
  return jwt.verify(token, env.jwtSecret);
}

function buildSessionCookieOptions() {
  return {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7,
    sameSite: 'lax',
    secure: isProductionEnv(),
  };
}

function clearSessionCookie(res) {
  res.clearCookie(AUTH_COOKIE_NAME, buildSessionCookieOptions());
}

function extractBearerToken(value) {
  if (!value || !value.startsWith('Bearer ')) return null;
  const token = value.slice('Bearer '.length).trim();
  return token || null;
}

module.exports = { createSessionToken, verifySessionToken, buildSessionCookieOptions, clearSessionCookie, extractBearerToken, AUTH_COOKIE_NAME };
