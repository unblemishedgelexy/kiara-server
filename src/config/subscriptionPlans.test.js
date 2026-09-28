const test = require('node:test');
const assert = require('node:assert/strict');
const { findPaidPlan, freePlan, getPublicPlans, paidPlans, toEntitlementPlan } = require('./subscriptionPlans');

test('exposes exactly the configured paid tiers and quotas', () => {
  assert.deepEqual(paidPlans.map((plan) => [plan.id, plan.priceInr, plan.liveMinutes, plan.chatMessages]), [
    ['starter', 199, 60, 300],
    ['pro', 299, 180, 1000],
    ['premium', 399, 400, 2500],
  ]);
  assert.deepEqual(getPublicPlans().map((plan) => plan.name), ['Starter', 'Pro', 'Premium']);
});

test('public plans omit Razorpay plan identifiers', () => {
  for (const plan of getPublicPlans()) {
    assert.equal('razorpayPlanId' in plan, false);
    assert.equal('pricePaise' in plan, false);
  }
});

test('unknown or absent paid subscriptions preserve the unlimited Free access', () => {
  assert.equal(toEntitlementPlan('unknown'), freePlan);
  assert.equal(toEntitlementPlan(null), freePlan);
  assert.equal(freePlan.liveMinutes, null);
  assert.equal(freePlan.chatMessages, null);
  assert.equal(findPaidPlan('pro').pricePaise, 29900);
});

test('prices are stored in Razorpay currency subunits and have configurable monthly limits', () => {
  assert.deepEqual(paidPlans.map((plan) => [plan.pricePaise, plan.currency, plan.interval]), [
    [19900, 'INR', 'monthly'],
    [29900, 'INR', 'monthly'],
    [39900, 'INR', 'monthly'],
  ]);
  assert.equal(paidPlans.every((plan) => Number.isInteger(plan.liveMinutes) && plan.liveMinutes > 0), true);
  assert.equal(paidPlans.every((plan) => Number.isInteger(plan.chatMessages) && plan.chatMessages > 0), true);
});