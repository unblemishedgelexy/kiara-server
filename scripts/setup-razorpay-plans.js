const Razorpay = require('razorpay');
const { env } = require('../src/config/env');
const { paidPlans } = require('../src/config/subscriptionPlans');

async function main() {
  if (!env.razorpayKeyId || !env.razorpayKeySecret) {
    throw new Error('Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET before provisioning plans.');
  }

  const razorpay = new Razorpay({
    key_id: env.razorpayKeyId,
    key_secret: env.razorpayKeySecret,
  });

  for (const plan of paidPlans) {
    if (plan.razorpayPlanId) {
      console.log(`RAZORPAY_PLAN_${plan.id.toUpperCase()}_ID=${plan.razorpayPlanId}`);
      continue;
    }

    const result = await razorpay.plans.create({
      period: 'monthly',
      interval: 1,
      item: {
        name: `Kiara ${plan.name} Monthly`,
        amount: plan.pricePaise,
        currency: plan.currency,
        description: `${plan.liveMinutes} Gemini Live minutes and ${plan.chatMessages} AI messages per month.`,
      },
    });

    console.log(`RAZORPAY_PLAN_${plan.id.toUpperCase()}_ID=${result.id}`);
  }
}

main().catch((error) => {
  console.error('[RAZORPAY_PLAN_SETUP_FAILED]', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});