const { env } = require('./env');

const paidPlans = [
  {
    id: 'starter',
    name: 'Starter',
    priceInr: env.subscriptionStarterPriceInr,
    pricePaise: Math.round(env.subscriptionStarterPriceInr * 100),
    currency: 'INR',
    interval: 'monthly',
    liveMinutes: env.subscriptionStarterLiveMinutes,
    chatMessages: env.subscriptionStarterChatMessages,
    razorpayPlanId: env.razorpayPlanStarterId,
    features: [
      '60 minutes of Gemini Live voice',
      '300 AI chat messages',
      'Basic conversation history',
      'Standard Kiara access',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    priceInr: env.subscriptionProPriceInr,
    pricePaise: Math.round(env.subscriptionProPriceInr * 100),
    currency: 'INR',
    interval: 'monthly',
    liveMinutes: env.subscriptionProLiveMinutes,
    chatMessages: env.subscriptionProChatMessages,
    razorpayPlanId: env.razorpayPlanProId,
    features: [
      '180 minutes of Gemini Live voice',
      '1,000 AI chat messages',
      'Extended conversation history',
      'Priority Kiara access',
    ],
  },
  {
    id: 'premium',
    name: 'Premium',
    priceInr: env.subscriptionPremiumPriceInr,
    pricePaise: Math.round(env.subscriptionPremiumPriceInr * 100),
    currency: 'INR',
    interval: 'monthly',
    liveMinutes: env.subscriptionPremiumLiveMinutes,
    chatMessages: env.subscriptionPremiumChatMessages,
    razorpayPlanId: env.razorpayPlanPremiumId,
    features: [
      '400 minutes of Gemini Live voice',
      '2,500 AI chat messages',
      'Extended conversation history',
      'Highest available priority',
    ],
  },
];

const freePlan = {
  id: 'free',
  name: 'Free',
  liveMinutes: null,
  chatMessages: null,
  features: ['Existing Kiara access'],
};

function findPaidPlan(planId) {
  return paidPlans.find((plan) => plan.id === planId) || null;
}

function getPublicPlans() {
  return paidPlans.map(({ id, name, priceInr, currency, interval, liveMinutes, chatMessages, features }) => ({
    id,
    name,
    priceInr,
    currency,
    interval,
    liveMinutes,
    chatMessages,
    features: [...features],
  }));
}

function toEntitlementPlan(planId) {
  const plan = findPaidPlan(planId);
  if (!plan) return freePlan;
  return {
    id: plan.id,
    name: plan.name,
    liveMinutes: plan.liveMinutes,
    chatMessages: plan.chatMessages,
  };
}

module.exports = {
  findPaidPlan,
  freePlan,
  getPublicPlans,
  paidPlans,
  toEntitlementPlan,
};

for (const plan of paidPlans) {
  if (
    !Number.isSafeInteger(plan.priceInr) || plan.priceInr <= 0 ||
    !Number.isSafeInteger(plan.pricePaise) || plan.pricePaise <= 0 ||
    !Number.isSafeInteger(plan.liveMinutes) || plan.liveMinutes <= 0 ||
    !Number.isSafeInteger(plan.chatMessages) || plan.chatMessages <= 0
  ) {
    throw new Error(`Subscription plan ${plan.id} has invalid price or monthly limits.`);
  }
}