const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const OAuthStateModel = require('../../models/OAuthState');
const AuthTicketModel = require('../../models/AuthTicket');
const { env, isAllowedOAuthReturnUrl } = require('../../config/env');
const { hashToken } = require('./tokenService');

function base64UrlEncode(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generateCodeVerifier() {
  return base64UrlEncode(crypto.randomBytes(64));
}

function createCodeChallenge(verifier) {
  return base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
}

function createState() {
  return base64UrlEncode(crypto.randomBytes(32));
}

async function createAuthRequest(returnUrl) {
  if (!returnUrl || typeof returnUrl !== 'string') {
    throw new Error('A redirectUri is required.');
  }

  if (!isAllowedOAuthReturnUrl(returnUrl)) {
    throw new Error('The requested redirect URL is not allowed.');
  }

  if (!env.googleClientId || !env.googleClientSecret || !env.googleOAuthRedirectUri) {
    throw new Error('Google OAuth is not configured on the server.');
  }

  const state = createState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  await OAuthStateModel.create({ state, codeVerifier, returnUrl, expiresAt });

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', env.googleClientId);
  authUrl.searchParams.set('redirect_uri', env.googleOAuthRedirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'select_account');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  return { authUrl: authUrl.toString(), state };
}

async function consumeAuthState(state) {
  if (!state) return null;
  const authState = await OAuthStateModel.findOneAndDelete({ state });
  return authState || null;
}

async function createAuthTicket(userId, accessToken, refreshToken) {
  const ticket = createState();
  const ticketHash = hashToken(ticket);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
  await AuthTicketModel.create({ ticketHash, userId, accessToken, refreshToken, expiresAt });
  return ticket;
}

async function consumeAuthTicket(ticket) {
  if (!ticket) return null;
  const ticketHash = hashToken(ticket);
  const authTicket = await AuthTicketModel.findOneAndDelete({ ticketHash });
  return authTicket || null;
}

async function exchangeCodeForTokens(code, codeVerifier) {
  if (!code || !codeVerifier) {
    throw new Error('Code and PKCE verifier are required for token exchange.');
  }

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: env.googleOAuthRedirectUri,
      code_verifier: codeVerifier,
    }).toString(),
  });

  const payload = await tokenResponse.json();

  if (!tokenResponse.ok || payload.error) {
    const message = payload.error_description || payload.error || 'Google token exchange failed.';
    throw new Error(message);
  }

  if (!payload.id_token) {
    throw new Error('Google token response did not include an ID token.');
  }

  return payload;
}

async function verifyIdToken(idToken) {
  if (!idToken) {
    throw new Error('ID token is required.');
  }

  const client = new OAuth2Client(env.googleClientId);
  const ticket = await client.verifyIdToken({
    idToken,
    audience: env.googleClientId,
  });

  const payload = ticket.getPayload();
  if (!payload) {
    throw new Error('Unable to verify Google ID token.');
  }

  if (!payload.email_verified) {
    throw new Error('Google email address is not verified.');
  }

  return payload;
}

module.exports = {
  createAuthRequest,
  consumeAuthState,
  createAuthTicket,
  consumeAuthTicket,
  exchangeCodeForTokens,
  verifyIdToken,
};
