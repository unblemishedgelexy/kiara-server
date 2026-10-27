'use strict';

const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { test } = require('node:test');
const OAuthStateModel = require('../../models/OAuthState');
const { env } = require('../../config/env');
const googleOAuthService = require('./googleOAuthService');

test('stores the requested Google sign-in purpose in the server-side OAuth state', async () => {
  const originals = {
    readyState: mongoose.connection.readyState,
    googleClientId: env.googleClientId,
    googleClientSecret: env.googleClientSecret,
    googleOAuthRedirectUri: env.googleOAuthRedirectUri,
    create: OAuthStateModel.create,
  };
  const savedStates = [];

  try {
    mongoose.connection.readyState = 1;
    env.googleClientId = 'test-client-id';
    env.googleClientSecret = 'test-client-secret';
    env.googleOAuthRedirectUri = 'http://localhost:4000/api/auth/google/callback';
    OAuthStateModel.create = async (state) => {
      savedStates.push(state);
      return state;
    };

    await googleOAuthService.createAuthRequest('http://localhost:5173/auth/callback', 'user');
    await googleOAuthService.createAuthRequest('http://localhost:5173/auth/callback');

    assert.deepEqual(savedStates.map(({ purpose }) => purpose), ['user', 'admin']);
    await assert.rejects(
      googleOAuthService.createAuthRequest('http://localhost:5173/auth/callback', 'owner'),
      /Unsupported Google sign-in purpose/,
    );
    assert.equal(savedStates.length, 2);
  } finally {
    mongoose.connection.readyState = originals.readyState;
    env.googleClientId = originals.googleClientId;
    env.googleClientSecret = originals.googleClientSecret;
    env.googleOAuthRedirectUri = originals.googleOAuthRedirectUri;
    OAuthStateModel.create = originals.create;
  }
});
