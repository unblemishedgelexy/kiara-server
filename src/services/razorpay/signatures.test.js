const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  createSubscriptionSignature,
  createWebhookSignature,
  verifySubscriptionSignature,
  verifyWebhookSignature,
} = require('./signatures');

test('verifies the Razorpay subscription payment signature', () => {
  const signature = crypto.createHmac('sha256', 'secret_test').update('pay_test|sub_test').digest('hex');
  assert.equal(createSubscriptionSignature('sub_test', 'pay_test', 'secret_test'), signature);
  assert.equal(verifySubscriptionSignature('sub_test', 'pay_test', signature, 'secret_test'), true);
  assert.equal(verifySubscriptionSignature('sub_other', 'pay_test', signature, 'secret_test'), false);
  assert.equal(verifySubscriptionSignature('sub_test', 'pay_test', 'not-a-signature', 'secret_test'), false);
});

test('verifies webhook signatures against the exact raw request body', () => {
  const body = '{"event":"subscription.activated"}';
  const signature = createWebhookSignature(body, 'webhook_secret');
  assert.equal(verifyWebhookSignature(body, signature, 'webhook_secret'), true);
  assert.equal(verifyWebhookSignature(`${body} `, signature, 'webhook_secret'), false);
  assert.equal(verifyWebhookSignature(body, signature, ''), false);
});