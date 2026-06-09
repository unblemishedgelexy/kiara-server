const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { env } = require('../config/env');

const ACCESS_TOKEN_EXPIRES = env.jwtAccessExpires || '15m';
const REFRESH_TOKEN_EXPIRES = env.jwtRefreshExpires || '30d';

function generateAccessToken(payload) {
  if (!payload) {
    console.error('❌ generateAccessToken: payload is missing', payload);
    throw new Error('Payload required to generate access token');
  }
  const secret = env.jwtAccessSecret || env.jwtSecret;
  if (!secret) {
    console.error('❌ JWT_ACCESS_SECRET not found in env');
    throw new Error('JWT_ACCESS_SECRET not configured');
  }
  const token = jwt.sign(payload, secret, { expiresIn: ACCESS_TOKEN_EXPIRES });
  if (!token) {
    console.error('❌ jwt.sign returned undefined');
    throw new Error('Failed to generate access token');
  }
  return token;
}

function generateRefreshToken(payload) {
  if (!payload) {
    console.error('❌ generateRefreshToken: payload is missing', payload);
    throw new Error('Payload required to generate refresh token');
  }
  const secret = env.jwtRefreshSecret || env.jwtSecret;
  if (!secret) {
    console.error('❌ JWT_REFRESH_SECRET not found in env');
    throw new Error('JWT_REFRESH_SECRET not configured');
  }
  const token = jwt.sign(payload, secret, { expiresIn: REFRESH_TOKEN_EXPIRES });
  if (!token) {
    console.error('❌ jwt.sign returned undefined');
    throw new Error('Failed to generate refresh token');
  }
  return token;
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.jwtAccessSecret || env.jwtSecret);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, env.jwtRefreshSecret || env.jwtSecret);
}

function hashToken(token) {
  if (!token || typeof token !== 'string') {
    console.error('❌ hashToken received invalid token:', token, 'type:', typeof token);
    throw new Error(`Token must be a non-empty string. Received: ${typeof token}`);
  }
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { generateAccessToken, generateRefreshToken, verifyAccessToken, verifyRefreshToken, hashToken };
