'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  getGoogleOAuthAccountDenialReason,
  isGoogleOAuthAccountAllowed,
} = require('./googleOAuthPolicy');

test('allows regular users and lets account reactivation validate inactive accounts', () => {
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
  }), true);
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

test('reports whether user Google sign-in was denied for an admin or identity conflict', () => {
  assert.equal(getGoogleOAuthAccountDenialReason({
    emailAccount: { role: 'admin', isActive: true },
  }), 'admin_account');
  assert.equal(getGoogleOAuthAccountDenialReason({
    emailAccount: { role: 'user', isActive: true },
    googleIdMismatch: true,
  }), 'identity_mismatch');
  assert.equal(getGoogleOAuthAccountDenialReason({
    emailAccount: { role: 'user', isActive: false },
  }), null);
  assert.equal(getGoogleOAuthAccountDenialReason({
    purpose: 'admin',
  }), 'unsupported_purpose');
});
