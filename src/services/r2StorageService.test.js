const assert = require('node:assert/strict');
const test = require('node:test');
const { env } = require('../config/env');
const { buildPublicUrl, isR2Configured } = require('./r2StorageService');

const r2Keys = [
  'r2AccountId',
  'r2AccessKeyId',
  'r2SecretAccessKey',
  'r2BucketName',
  'r2PublicBaseUrl',
];

function withR2Config(config, run) {
  const original = Object.fromEntries(r2Keys.map((key) => [key, env[key]]));
  Object.assign(env, config);
  try {
    return run();
  } finally {
    Object.assign(env, original);
  }
}

test('buildPublicUrl encodes object path segments beneath the public bucket base', () => {
  withR2Config({ r2PublicBaseUrl: 'https://downloads.example.com/releases' }, () => {
    assert.equal(
      buildPublicUrl('kiara-apk/release build.apk'),
      'https://downloads.example.com/releases/kiara-apk/release%20build.apk',
    );
  });
});

test('R2 configuration requires credentials and an HTTPS public base URL', () => {
  const credentials = {
    r2AccountId: 'account',
    r2AccessKeyId: 'access-key',
    r2SecretAccessKey: 'secret-key',
    r2BucketName: 'kiara-apks',
  };

  withR2Config({ ...credentials, r2PublicBaseUrl: 'https://downloads.example.com' }, () => {
    assert.equal(isR2Configured(), true);
  });
  withR2Config({ ...credentials, r2PublicBaseUrl: 'http://downloads.example.com' }, () => {
    assert.equal(isR2Configured(), false);
  });
});
