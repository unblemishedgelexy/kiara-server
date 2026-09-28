const crypto = require('crypto');

function safeHexEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  if (!/^[a-f0-9]{64}$/i.test(actual) || !/^[a-f0-9]{64}$/i.test(expected)) return false;

  const actualBuffer = Buffer.from(actual, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function createSubscriptionSignature(subscriptionId, paymentId, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${paymentId}|${subscriptionId}`)
    .digest('hex');
}

function verifySubscriptionSignature(subscriptionId, paymentId, signature, secret) {
  if (!subscriptionId || !paymentId || !secret) return false;
  return safeHexEqual(signature, createSubscriptionSignature(subscriptionId, paymentId, secret));
}

function createWebhookSignature(rawBody, secret) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function verifyWebhookSignature(rawBody, signature, secret) {
  if (typeof rawBody !== 'string' || !rawBody || !secret) return false;
  return safeHexEqual(signature, createWebhookSignature(rawBody, secret));
}

module.exports = {
  createSubscriptionSignature,
  createWebhookSignature,
  verifySubscriptionSignature,
  verifyWebhookSignature,
};