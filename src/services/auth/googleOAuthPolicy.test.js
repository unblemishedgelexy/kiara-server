'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { isGoogleOAuthAccountAllowed } = require('./googleOAuthPolicy');

test('allows regular users in the user Google sign-in flow', () => {
  assert.equal(isGoogleOAuthAccountAllowed({
    purpose: 'user',
    emailAccount: { role: 'user', isActive: true },
  }), true);
  assert.equal(isGoogleOAuthAccountAllowed({
    purpose: 'user',
    emailAccount: null,
  }), true);
  assert.equal(isGoogleOAuthAccountAllowed({
    purpose: 'user',
    emailAccount: { role: 'user', isActive: false },
  }), false);
  assert.equal(isGoogleOAuthAccountAllowed({
    purpose: 'user',
    emailAccount: { role: 'admin', isActive: true },
  }), false);
  assert.equal(isGoogleOAuthAccountAllowed({
    purpose: 'user',
    emailAccount: { role: 'dev', isActive: true },
  }), false);
});

test('does not allow administrator accounts to use Google user sign-in', () => {
  assert.equal(isGoogleOAuthAccountAllowed({
    emailAccount: { role: 'admin', isActive: true },
  }), false);
  assert.equal(isGoogleOAuthAccountAllowed({
    emailAccount: { role: 'dev', isActive: true },
  }), false);
  assert.equal(isGoogleOAuthAccountAllowed({
    emailAccount: { role: 'user', isActive: true },
  }), true);
  assert.equal(isGoogleOAuthAccountAllowed({
    emailAccount: { role: 'admin', isActive: false },
  }), false);
});

test('rejects Google identity conflicts in either sign-in flow', () => {
  assert.equal(isGoogleOAuthAccountAllowed({
    purpose: 'user',
    googleIdMismatch: true,
  }), false);
  assert.equal(isGoogleOAuthAccountAllowed({
    purpose: 'user',
    emailMismatch: true,
  }), false);
  assert.equal(isGoogleOAuthAccountAllowed({
    emailAccount: { role: 'admin', isActive: true },
    googleIdMismatch: true,
  }), false);
});
