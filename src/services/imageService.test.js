'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { env } = require('../config/env');
const { isImageKitConfigured } = require('./imageService');

test('ImageKit upload configuration requires all server credentials', () => {
  const original = {
    publicKey: env.imagekitPublicKey,
    privateKey: env.imagekitPrivateKey,
    urlEndpoint: env.imagekitUrlEndpoint,
  };
  try {
    env.imagekitPublicKey = 'public-key';
    env.imagekitPrivateKey = 'private-key';
    env.imagekitUrlEndpoint = 'https://ik.example.com';
    assert.equal(isImageKitConfigured(), true);

    env.imagekitPrivateKey = '';
    assert.equal(isImageKitConfigured(), false);
  } finally {
    env.imagekitPublicKey = original.publicKey;
    env.imagekitPrivateKey = original.privateKey;
    env.imagekitUrlEndpoint = original.urlEndpoint;
  }
});

test('APK upload limit is 25 MiB', () => {
  assert.equal(env.imagekitMaxApkSizeBytes, 25 * 1024 * 1024);
});
