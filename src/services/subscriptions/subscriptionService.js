const Subscription = require('../../models/Subscription');
const RazorpayPayment = require('../../models/RazorpayPayment');
const RazorpayWebhookEvent = require('../../models/RazorpayWebhookEvent');
const { env } = require('../../config/env');
const { findPaidPlan, paidPlans } = require('../../config/subscriptionPlans');
const { createRazorpayClient, isCheckoutConfigured } = require('../razorpay/razorpayClient');
const { verifySubscriptionSignature, verifyWebhookSignature } = require('../razorpay/signatures');
const usageService = require('./usageService');

function serviceError(message, code, statusCode = 400, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function fromUnixSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}

function findPlanByRazorpayId(providerPlanId) {
  return paidPlans.find((plan) => plan.razorpayPlanId && plan.razorpayPlanId === providerPlanId) || null;
}

async function assertProviderPlanMatches(razorpay, plan) {
  const providerPlan = await razorpay.plans.fetch(plan.razorpayPlanId);
  if (
    providerPlan.id !== plan.razorpayPlanId ||
    providerPlan.item?.amount !== plan.pricePaise ||
    providerPlan.item?.currency !== plan.currency ||
    providerPlan.period !== 'monthly' ||
    providerPlan.interval !== 1
  ) {
    throw serviceError('Configured Razorpay plan does not match the server-side price and monthly interval.', 'RAZORPAY_PLAN_MISMATCH', 503);
  }
  return providerPlan;
}

function getPublicCheckoutConfig() {
  return {
    available: isCheckoutConfigured(),
    keyId: isCheckoutConfigured() ? env.razorpayKeyId : null,
  };
}

async function getAccountOverview(userId) {
  const [usage, latestSubscription] = await Promise.all([
    usageService.getOverview(userId),
    Subscription.findOne({ userId }).sort({ createdAt: -1 }).lean(),
  ]);

  return {
    ...usage,
    checkout: getPublicCheckoutConfig(),
    latestSubscription: latestSubscription ? {
      planId: latestSubscription.planId,
      status: latestSubscription.status,
      pendingPlanId: latestSubscription.pendingPlanId,
      pendingPlanChangeAt: latestSubscription.pendingPlanChangeAt,
      cancelAtCycleEnd: latestSubscription.cancelAtCycleEnd,
    } : null,
  };
}

async function createOrUpdateCheckout(userId, planId, customerEmail) {
  const desiredPlan = findPaidPlan(planId);
  if (!desiredPlan) {
    throw serviceError('Choose one of the available Kiara plans.', 'INVALID_PLAN', 400);
  }
  if (!isCheckoutConfigured()) {
    throw serviceError('Razorpay test/live keys and all plan IDs must be configured before checkout.', 'RAZORPAY_NOT_CONFIGURED', 503);
  }

  const current = await usageService.getCurrentSubscription(userId);
  if (!current) {
    const awaitingActivation = await Subscription.findOne({
      userId,
      status: { $in: ['authenticated', 'pending'] },
    }).sort({ createdAt: -1 }).lean();
    if (awaitingActivation) {
      throw serviceError('Your existing Razorpay subscription is still processing. Refresh subscription status before creating another.', 'SUBSCRIPTION_ACTIVATION_PENDING', 409);
    }
  }
  const razorpay = createRazorpayClient();
  await assertProviderPlanMatches(razorpay, desiredPlan);

  if (current) {
    if (current.planId === desiredPlan.id) {
      throw serviceError('This is already your current plan.', 'PLAN_ALREADY_ACTIVE', 409);
    }
    if (current.cancelAtCycleEnd) {
      throw serviceError('Your current plan is scheduled to end. You can choose another plan after it expires.', 'SUBSCRIPTION_ENDING', 409);
    }
    if (current.pendingPlanId) {
      throw serviceError('A plan change is already scheduled for this billing cycle.', 'PLAN_CHANGE_PENDING', 409);
    }
    if (!['active', 'authenticated'].includes(current.status)) {
      throw serviceError('This subscription cannot be changed in its current state.', 'SUBSCRIPTION_NOT_CHANGEABLE', 409);
    }

    const updated = await razorpay.subscriptions.update(current.razorpaySubscriptionId, {
      plan_id: desiredPlan.razorpayPlanId,
      schedule_change_at: 'cycle_end',
      customer_notify: true,
    });
    const effectiveAt = fromUnixSeconds(updated.change_scheduled_at) || current.renewalDate || null;
    await Subscription.updateOne(
      { _id: current._id, userId, pendingPlanId: null },
      { $set: { pendingPlanId: desiredPlan.id, pendingPlanChangeAt: effectiveAt } },
    );
    return {
      action: 'scheduled_change',
      planId: desiredPlan.id,
      effectiveAt,
    };
  }

  const existingCheckout = await Subscription.findOne({
    userId,
    status: 'created',
    checkoutExpiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 }).lean();
  if (!current && existingCheckout && existingCheckout.planId !== desiredPlan.id) {
    throw serviceError('A checkout for another plan is already pending. Finish or let it expire before starting a new one.', 'CHECKOUT_ALREADY_PENDING', 409);
  }
  if (existingCheckout) {
    const remote = await razorpay.subscriptions.fetch(existingCheckout.razorpaySubscriptionId);
    return {
      action: 'checkout',
      keyId: env.razorpayKeyId,
      subscriptionId: existingCheckout.razorpaySubscriptionId,
      shortUrl: remote.short_url || null,
      plan: { id: desiredPlan.id, name: desiredPlan.name, priceInr: desiredPlan.priceInr, currency: desiredPlan.currency },
    };
  }

  const remote = await razorpay.subscriptions.create({
    plan_id: desiredPlan.razorpayPlanId,
    total_count: env.razorpaySubscriptionTotalCount,
    quantity: 1,
    customer_notify: true,
    notes: {
      kiara_user_id: String(userId),
      kiara_plan_id: desiredPlan.id,
    },
  });

  await Subscription.create({
    userId,
    planId: desiredPlan.id,
    status: 'created',
    amountPaise: desiredPlan.pricePaise,
    currency: desiredPlan.currency,
    razorpaySubscriptionId: remote.id,
    razorpayPlanId: desiredPlan.razorpayPlanId,
    razorpayCustomerId: remote.customer_id || null,
    checkoutExpiresAt: fromUnixSeconds(remote.expire_by),
  });

  return {
    action: 'checkout',
    keyId: env.razorpayKeyId,
    subscriptionId: remote.id,
    shortUrl: remote.short_url || null,
    prefill: { email: customerEmail || '' },
    plan: { id: desiredPlan.id, name: desiredPlan.name, priceInr: desiredPlan.priceInr, currency: desiredPlan.currency },
  };
}

async function recordCapturedPayment({ userId, localSubscription, payment, requireCurrentPlanAmount = false }) {
  if (!payment || payment.status !== 'captured') {
    throw serviceError('The Razorpay payment is not captured yet.', 'PAYMENT_NOT_CAPTURED', 402);
  }
  if (payment.subscription_id !== localSubscription.razorpaySubscriptionId) {
    throw serviceError('Payment does not belong to this subscription.', 'PAYMENT_SUBSCRIPTION_MISMATCH', 403);
  }

  const paymentPlan = findPlanByRazorpayId(payment.plan_id) || findPaidPlan(localSubscription.planId);
  const validServerPlanAmount = paidPlans.some((plan) => plan.pricePaise === payment.amount && plan.currency === payment.currency);
  const expectedAmount = requireCurrentPlanAmount
    ? findPaidPlan(localSubscription.planId)?.pricePaise
    : null;
  if (
    !paymentPlan ||
    !validServerPlanAmount ||
    (expectedAmount !== null && payment.amount !== expectedAmount) ||
    payment.currency !== localSubscription.currency
  ) {
    throw serviceError('Payment amount or currency does not match the server-side plan.', 'PAYMENT_AMOUNT_MISMATCH', 403);
  }

  try {
    await RazorpayPayment.create({
      userId,
      subscriptionId: localSubscription.razorpaySubscriptionId,
      paymentId: payment.id,
      amountPaise: payment.amount,
      currency: payment.currency,
      status: payment.status,
      paidAt: fromUnixSeconds(payment.created_at) || new Date(),
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
}

async function verifyCheckoutPayment(userId, input) {
  const { razorpayPaymentId, razorpaySubscriptionId, razorpaySignature } = input;
  const localSubscription = await Subscription.findOne({ userId, razorpaySubscriptionId });
  if (!localSubscription) {
    throw serviceError('Subscription was not created for this account.', 'SUBSCRIPTION_NOT_FOUND', 404);
  }
  if (!verifySubscriptionSignature(
    razorpaySubscriptionId,
    razorpayPaymentId,
    razorpaySignature,
    env.razorpayKeySecret,
  )) {
    throw serviceError('Razorpay payment signature verification failed.', 'INVALID_PAYMENT_SIGNATURE', 403);
  }

  const razorpay = createRazorpayClient();
  const [providerSubscription, providerPayment] = await Promise.all([
    razorpay.subscriptions.fetch(razorpaySubscriptionId),
    razorpay.payments.fetch(razorpayPaymentId),
  ]);

  if (
    providerSubscription.id !== localSubscription.razorpaySubscriptionId ||
    providerSubscription.plan_id !== localSubscription.razorpayPlanId
  ) {
    throw serviceError('Razorpay subscription does not match the selected server-side plan.', 'SUBSCRIPTION_PLAN_MISMATCH', 403);
  }
  await recordCapturedPayment({ userId, localSubscription, payment: providerPayment, requireCurrentPlanAmount: true });

  const isProviderActive = ['active', 'authenticated'].includes(providerSubscription.status);
  const pendingActivation = !isProviderActive;
  const updates = {
    paymentId: providerPayment.id,
    razorpayCustomerId: providerSubscription.customer_id || localSubscription.razorpayCustomerId,
    status: providerSubscription.status === 'active' ? 'active' : pendingActivation ? 'pending' : 'authenticated',
    startedAt: fromUnixSeconds(providerSubscription.current_start) || (providerSubscription.status === 'active' ? new Date() : null),
    renewalDate: fromUnixSeconds(providerSubscription.current_end),
    expiresAt: fromUnixSeconds(providerSubscription.ended_at),
    checkoutExpiresAt: null,
  };

  const updated = await Subscription.findOneAndUpdate(
    { _id: localSubscription._id, userId },
    { $set: updates },
    { returnDocument: 'after' },
  ).lean();

  return {
    activated: updated.status === 'active',
    status: updated.status,
    subscription: updated,
  };
}

async function cancelCurrentSubscription(userId) {
  const subscription = await usageService.getCurrentSubscription(userId);
  if (!subscription) {
    throw serviceError('There is no active subscription to cancel.', 'SUBSCRIPTION_NOT_ACTIVE', 409);
  }
  if (subscription.cancelAtCycleEnd) {
    return { cancelled: true, cancelAtCycleEnd: true, expiresAt: subscription.expiresAt };
  }

  const razorpay = createRazorpayClient();
  const providerSubscription = await razorpay.subscriptions.cancel(subscription.razorpaySubscriptionId, true);
  const providerEnd = fromUnixSeconds(providerSubscription.current_end);
  await Subscription.updateOne(
    { _id: subscription._id, userId },
    {
      $set: {
        cancelAtCycleEnd: true,
        status: providerSubscription.status === 'cancelled' ? 'cancelled' : subscription.status,
        expiresAt: providerEnd || subscription.expiresAt,
      },
    },
  );

  return { cancelled: true, cancelAtCycleEnd: true, expiresAt: providerEnd || subscription.expiresAt };
}

async function activateFromProvider({ localSubscription, providerSubscription, payment, eventId }) {
  const providerPlan = findPlanByRazorpayId(providerSubscription.plan_id);
  if (!providerPlan) {
    throw serviceError('Webhook refers to an unconfigured Razorpay plan.', 'UNKNOWN_RAZORPAY_PLAN', 400);
  }

  if (payment) {
    if (payment.subscription_id !== localSubscription.razorpaySubscriptionId) {
      throw serviceError('Webhook payment belongs to another subscription.', 'PAYMENT_SUBSCRIPTION_MISMATCH', 400);
    }
    await recordCapturedPayment({
      userId: localSubscription.userId,
      localSubscription,
      payment,
    });
  }

  const planChanged = providerPlan.id !== localSubscription.planId;
  const update = {
    status: providerSubscription.status === 'active' || providerSubscription.status === 'authenticated'
      ? 'active'
      : providerSubscription.status,
    razorpayCustomerId: providerSubscription.customer_id || localSubscription.razorpayCustomerId,
    startedAt: fromUnixSeconds(providerSubscription.current_start) || localSubscription.startedAt || new Date(),
    renewalDate: fromUnixSeconds(providerSubscription.current_end) || localSubscription.renewalDate,
    lastWebhookEvent: eventId,
  };
  if (planChanged) {
    update.planId = providerPlan.id;
    update.razorpayPlanId = providerPlan.razorpayPlanId;
    update.amountPaise = providerPlan.pricePaise;
    update.pendingPlanId = null;
    update.pendingPlanChangeAt = null;
  }
  if (payment) update.paymentId = payment.id;

  await Subscription.updateOne({ _id: localSubscription._id }, { $set: update });
}

async function processSubscriptionWebhookEvent(eventId, event, payload) {
  const subscriptionEntity = payload?.subscription?.entity;
  const paymentEntity = payload?.payment?.entity;
  const subscriptionId = subscriptionEntity?.id || paymentEntity?.subscription_id;
  if (!subscriptionId) return { processed: false, reason: 'subscription_id_missing' };

  const localSubscription = await Subscription.findOne({ razorpaySubscriptionId: subscriptionId });
  if (!localSubscription) return { processed: false, reason: 'subscription_not_owned_by_kiara' };

  const supported = new Set([
    'subscription.activated',
    'subscription.authenticated',
    'subscription.charged',
    'subscription.pending',
    'subscription.halted',
    'subscription.paused',
    'subscription.resumed',
    'subscription.cancelled',
    'subscription.completed',
    'subscription.expired',
  ]);
  if (!supported.has(event)) return { processed: false, reason: 'event_ignored' };

  const providerSubscription = await createRazorpayClient().subscriptions.fetch(subscriptionId);
  const providerPlan = findPlanByRazorpayId(providerSubscription.plan_id);
  if (!providerPlan) {
    throw serviceError('Webhook refers to an unconfigured Razorpay plan.', 'UNKNOWN_RAZORPAY_PLAN', 400);
  }
  const storedPlanIds = [
    localSubscription.razorpayPlanId,
    findPaidPlan(localSubscription.pendingPlanId)?.razorpayPlanId,
  ].filter(Boolean);
  if (!storedPlanIds.includes(providerSubscription.plan_id)) {
    throw serviceError('Webhook subscription plan does not match the stored subscription.', 'SUBSCRIPTION_PLAN_MISMATCH', 400);
  }

  if (['subscription.activated', 'subscription.charged', 'subscription.resumed'].includes(event)) {
    await activateFromProvider({
      localSubscription,
      providerSubscription,
      payment: event === 'subscription.charged' ? paymentEntity : null,
      eventId,
    });
    return { processed: true };
  }

  const supportedStatuses = new Set(['created', 'authenticated', 'active', 'pending', 'halted', 'paused', 'cancelled', 'completed', 'expired']);
  if (!supportedStatuses.has(providerSubscription.status)) {
    throw serviceError('Razorpay returned an unsupported subscription status.', 'UNKNOWN_SUBSCRIPTION_STATUS', 502);
  }
  const update = {
    status: providerSubscription.status,
    lastWebhookEvent: eventId,
    renewalDate: fromUnixSeconds(providerSubscription.current_end) || localSubscription.renewalDate,
    expiresAt: ['cancelled', 'completed', 'expired'].includes(providerSubscription.status)
      ? fromUnixSeconds(providerSubscription.ended_at) || fromUnixSeconds(providerSubscription.current_end)
      : localSubscription.expiresAt,
  };
  if (providerPlan.id !== localSubscription.planId) {
    update.planId = providerPlan.id;
    update.razorpayPlanId = providerPlan.razorpayPlanId;
    update.amountPaise = providerPlan.pricePaise;
    update.pendingPlanId = null;
    update.pendingPlanChangeAt = null;
  }
  if (providerSubscription.status === 'cancelled') update.cancelAtCycleEnd = false;
  await Subscription.updateOne({ _id: localSubscription._id }, { $set: update });
  return { processed: true };
}

async function processWebhook(rawBody, signature, eventIdHeader) {
  if (!env.razorpayWebhookSecret) {
    throw serviceError('Razorpay webhook verification is not configured.', 'WEBHOOK_NOT_CONFIGURED', 503);
  }
  if (!verifyWebhookSignature(rawBody, signature, env.razorpayWebhookSecret)) {
    throw serviceError('Razorpay webhook signature verification failed.', 'INVALID_WEBHOOK_SIGNATURE', 403);
  }
  if (typeof eventIdHeader !== 'string' || !eventIdHeader.trim()) {
    throw serviceError('Razorpay webhook event ID is required.', 'WEBHOOK_EVENT_ID_REQUIRED', 400);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw serviceError('Razorpay webhook body is invalid JSON.', 'INVALID_WEBHOOK_BODY', 400);
  }
  const event = payload.event;
  const signedBodyHash = require('crypto').createHash('sha256').update(rawBody).digest('hex');
  const payloadEventId = typeof payload.id === 'string' ? payload.id : null;
  if (payloadEventId && payloadEventId !== eventIdHeader) {
    throw serviceError('Razorpay webhook event ID does not match its signed payload.', 'WEBHOOK_EVENT_ID_MISMATCH', 400);
  }

  try {
    await RazorpayWebhookEvent.create({ _id: signedBodyHash, eventId: eventIdHeader, event });
  } catch (error) {
    if (error?.code === 11000) return { duplicate: true };
    throw error;
  }

  try {
    return await processSubscriptionWebhookEvent(eventIdHeader, event, payload.payload || {});
  } catch (error) {
    await RazorpayWebhookEvent.deleteOne({ _id: signedBodyHash });
    throw error;
  }
}

module.exports = {
  cancelCurrentSubscription,
  createOrUpdateCheckout,
  getAccountOverview,
  getPublicCheckoutConfig,
  processWebhook,
  serviceError,
  verifyCheckoutPayment,
};