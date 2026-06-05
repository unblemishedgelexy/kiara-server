const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { env } = require('../config/env');

const ACCESS_TOKEN_EXPIRES = env.jwtAccessExpires || '15m';
const REFRESH_TOKEN_EXPIRES = env.jwtRefreshExpires || '30d';

function generateAccessToken(payload) {
  return jwt.sign(payload, env.jwtAccessSecret || env.jwtSecret, { expiresIn: ACCESS_TOKEN_EXPIRES });
}

function generateRefreshToken(payload) {
  return jwt.sign(payload, env.jwtRefreshSecret || env.jwtSecret, { expiresIn: REFRESH_TOKEN_EXPIRES });
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.jwtAccessSecret || env.jwtSecret);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, env.jwtRefreshSecret || env.jwtSecret);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { generateAccessToken, generateRefreshToken, verifyAccessToken, verifyRefreshToken, hashToken };
