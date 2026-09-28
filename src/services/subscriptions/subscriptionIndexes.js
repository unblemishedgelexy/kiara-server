const Subscription = require('../../models/Subscription');
const SubscriptionUsage = require('../../models/SubscriptionUsage');
const RazorpayPayment = require('../../models/RazorpayPayment');
const RazorpayWebhookEvent = require('../../models/RazorpayWebhookEvent');

async function ensureSubscriptionIndexes() {
  await Promise.all([
    Subscription.createIndexes(),
    SubscriptionUsage.createIndexes(),
    RazorpayPayment.createIndexes(),
    RazorpayWebhookEvent.createIndexes(),
  ]);
}

module.exports = { ensureSubscriptionIndexes };