const Razorpay = require('razorpay');
const { env } = require('../../config/env');
const { paidPlans } = require('../../config/subscriptionPlans');

function hasRazorpayCredentials() {
  return Boolean(env.razorpayKeyId && env.razorpayKeySecret);
}

function hasConfiguredRazorpayPlans() {
  return paidPlans.every((plan) => typeof plan.razorpayPlanId === 'string' && plan.razorpayPlanId.trim());
}

function isCheckoutConfigured() {
  return hasRazorpayCredentials() && hasConfiguredRazorpayPlans();
}

function createRazorpayClient() {
  if (!hasRazorpayCredentials()) {
    const error = new Error('Razorpay checkout is not configured.');
    error.statusCode = 503;
    error.code = 'RAZORPAY_NOT_CONFIGURED';
    throw error;
  }

  return new Razorpay({
    key_id: env.razorpayKeyId,
    key_secret: env.razorpayKeySecret,
  });
}

module.exports = {
  createRazorpayClient,
  hasRazorpayCredentials,
  hasConfiguredRazorpayPlans,
  isCheckoutConfigured,
};