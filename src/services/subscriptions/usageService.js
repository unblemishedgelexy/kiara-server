const { randomUUID } = require('crypto');
const Subscription = require('../../models/Subscription');
const SubscriptionUsage = require('../../models/SubscriptionUsage');
const { findPaidPlan, freePlan, getPublicPlans, toEntitlementPlan } = require('../../config/subscriptionPlans');
const { isCheckoutConfigured } = require('../razorpay/razorpayClient');

const CHAT_RESERVATION_TTL_MS = 15 * 60 * 1000;
const LIVE_SESSION_STALE_MS = 90 * 1000;
const MAX_LIVE_HEARTBEAT_SECONDS = Math.floor(LIVE_SESSION_STALE_MS / 1000);

function getUtcBillingPeriod(now = new Date()) {
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { periodStart, periodEnd };
}

function createUsageError(message, code, statusCode = 402, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function calculateLiveCharge(elapsedSeconds, liveSeconds, maxSeconds) {
  const elapsed = Math.max(0, Math.min(MAX_LIVE_HEARTBEAT_SECONDS, Math.floor(elapsedSeconds)));
  const remaining = maxSeconds === null ? elapsed : Math.max(0, maxSeconds - liveSeconds);
  const billedSeconds = Math.min(elapsed, remaining);
  return {
    billedSeconds,
    limitReached: maxSeconds !== null && liveSeconds + billedSeconds >= maxSeconds,
  };
}

async function ensureUsageRow(userId, period = getUtcBillingPeriod()) {
  try {
    return await SubscriptionUsage.findOneAndUpdate(
      { userId, periodStart: period.periodStart },
      {
        $setOnInsert: {
          userId,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          liveSeconds: 0,
          chatMessages: 0,
        },
      },
      { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return SubscriptionUsage.findOne({ userId, periodStart: period.periodStart });
  }
}

async function getCurrentSubscription(userId, now = new Date()) {
  return Subscription.findOne({
    userId,
    $or: [
      { status: 'active', $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
      { status: 'cancelled', cancelAtCycleEnd: true, expiresAt: { $gt: now } },
    ],
  }).sort({ expiresAt: -1, createdAt: -1 }).lean();
}

async function getOverview(userId, now = new Date()) {
  const period = getUtcBillingPeriod(now);
  const [subscription, latestSubscription, usage] = await Promise.all([
    getCurrentSubscription(userId, now),
    Subscription.findOne({ userId }).sort({ createdAt: -1 }).lean(),
    ensureUsageRow(userId, period),
  ]);
  const plan = subscription
    ? toEntitlementPlan(subscription.planId)
    : freePlan;
  const currentPaidPlan = subscription ? findPaidPlan(subscription.planId) : null;
  const status = subscription
    ? subscription.status
    : latestSubscription?.expiresAt && latestSubscription.expiresAt <= now
      ? 'expired'
      : latestSubscription?.status || 'free';

  return {
    checkoutAvailable: isCheckoutConfigured(),
    currentPlan: {
      ...plan,
      priceInr: currentPaidPlan?.priceInr ?? 0,
      currency: currentPaidPlan?.currency ?? 'INR',
    },
    plans: getPublicPlans(),
    status,
    subscription: subscription ? {
      id: String(subscription._id),
      planId: subscription.planId,
      status: subscription.status,
      renewalDate: subscription.renewalDate,
      expiresAt: subscription.expiresAt,
      cancelAtCycleEnd: subscription.cancelAtCycleEnd,
    } : null,
    usage: {
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      liveSeconds: usage?.liveSeconds || 0,
      liveMinutes: Math.floor((usage?.liveSeconds || 0) / 60),
      liveMinutesLimit: plan.liveMinutes,
      chatMessages: usage?.chatMessages || 0,
      chatMessagesLimit: plan.chatMessages,
    },
  };
}

async function reserveChatMessage(userId) {
  const now = new Date();
  const period = getUtcBillingPeriod(now);
  const plan = await getCurrentSubscription(userId, now);
  const entitlement = plan ? toEntitlementPlan(plan.planId) : freePlan;
  const usage = await ensureUsageRow(userId, period);
  const reservationId = randomUUID();
  const expiresAt = new Date(now.getTime() + CHAT_RESERVATION_TTL_MS);

  await SubscriptionUsage.updateOne(
    { _id: usage._id },
    { $pull: { pendingChatReservations: { expiresAt: { $lte: now } } } },
  );

  const reservedCount = { $size: { $ifNull: ['$pendingChatReservations', []] } };
  const usageCount = {
    $add: [
      { $ifNull: ['$chatMessages', 0] },
      reservedCount,
    ],
  };
  const expressionChecks = [{ $lt: [reservedCount, 5] }];
  if (entitlement.chatMessages !== null) {
    expressionChecks.push({ $lt: [usageCount, entitlement.chatMessages] });
  }
  const filter = {
    _id: usage._id,
    $expr: { $and: expressionChecks },
  };

  const updated = await SubscriptionUsage.findOneAndUpdate(
    filter,
    { $push: { pendingChatReservations: { id: reservationId, expiresAt } } },
    { returnDocument: 'after' },
  );

  if (!updated) {
    throw createUsageError('Your monthly AI chat usage is complete.', 'USAGE_LIMIT_REACHED', 402, {
      plan: entitlement.id,
      usage: usage.chatMessages,
      limit: entitlement.chatMessages,
      upgradeAvailable: true,
    });
  }

  return {
    reservationId,
    usage: updated.chatMessages,
    limit: entitlement.chatMessages,
    plan: entitlement.id,
  };
}

async function commitChatMessage(userId, reservationId) {
  const result = await SubscriptionUsage.findOneAndUpdate(
    {
      userId,
      'pendingChatReservations.id': reservationId,
    },
    {
      $pull: { pendingChatReservations: { id: reservationId } },
      $inc: { chatMessages: 1 },
    },
    { returnDocument: 'after' },
  );
  return { committed: Boolean(result), chatMessages: result?.chatMessages ?? null };
}

async function releaseChatReservation(userId, reservationId) {
  if (!reservationId) return { released: false };
  const result = await SubscriptionUsage.updateOne(
    { userId, 'pendingChatReservations.id': reservationId },
    { $pull: { pendingChatReservations: { id: reservationId } } },
  );
  return { released: result.modifiedCount > 0 };
}

async function startLiveSession(userId, lifecycleTrigger = 'LIVE_SESSION_START', now = new Date()) {
  const period = getUtcBillingPeriod(now);
  const currentPlan = await getCurrentSubscription(userId, now);
  const plan = currentPlan ? toEntitlementPlan(currentPlan.planId) : freePlan;
  const liveLimitSeconds = plan.liveMinutes === null ? null : plan.liveMinutes * 60;
  let usage = await ensureUsageRow(userId, period);
  const isResume = lifecycleTrigger === 'LIVE_TOKEN_REFRESH' || lifecycleTrigger === 'LIVE_SESSION_RECONNECT';

  if (usage.activeLiveSessionId) {
    const activeId = usage.activeLiveSessionId;
    const lastHeartbeat = usage.lastLiveHeartbeatAt || usage.updatedAt || usage.createdAt;
    const ageMs = now.getTime() - new Date(lastHeartbeat).getTime();

    if (isResume && ageMs < LIVE_SESSION_STALE_MS) {
      const heartbeat = await heartbeatLiveSession(userId, activeId, now);
      if (!heartbeat.allowed) {
        throw createUsageError('Your monthly AI voice usage is complete.', 'USAGE_LIMIT_REACHED', 402, {
          plan: plan.id,
          usage: Math.ceil(heartbeat.liveSeconds / 60),
          limit: plan.liveMinutes,
          upgradeAvailable: true,
        });
      }
      return { sessionId: activeId, created: false };
    }

    if (!isResume && ageMs < LIVE_SESSION_STALE_MS) {
      throw createUsageError('A Kiara Live session is already active for this account.', 'LIVE_SESSION_ALREADY_ACTIVE', 409);
    }

    const finalHeartbeat = await heartbeatLiveSession(userId, activeId, now).catch((error) => {
      if (error.code === 'LIVE_SESSION_NOT_ACTIVE') return null;
      throw error;
    });
    if (finalHeartbeat && !finalHeartbeat.allowed) {
      throw createUsageError('Your monthly AI voice usage is complete.', 'USAGE_LIMIT_REACHED', 402, {
        plan: plan.id,
        usage: Math.ceil(finalHeartbeat.liveSeconds / 60),
        limit: plan.liveMinutes,
        upgradeAvailable: true,
      });
    }

    await SubscriptionUsage.updateOne(
      { _id: usage._id, activeLiveSessionId: activeId },
      { $set: { activeLiveSessionId: null, lastLiveHeartbeatAt: null } },
    );
    usage = await ensureUsageRow(userId, period);
  }

  const sessionId = randomUUID();

  if (liveLimitSeconds !== null && usage.liveSeconds >= liveLimitSeconds) {
    throw createUsageError('Your monthly AI voice usage is complete.', 'USAGE_LIMIT_REACHED', 402, {
      plan: plan.id,
      usage: Math.ceil(usage.liveSeconds / 60),
      limit: plan.liveMinutes,
      upgradeAvailable: true,
    });
  }

  const claimFilter = {
    _id: usage._id,
    activeLiveSessionId: null,
    ...(liveLimitSeconds === null ? {} : { liveSeconds: { $lt: liveLimitSeconds } }),
  };
  const claimed = await SubscriptionUsage.findOneAndUpdate(
    claimFilter,
    { $set: { activeLiveSessionId: sessionId, lastLiveHeartbeatAt: now } },
    { returnDocument: 'after' },
  );

  if (!claimed) {
    const latest = await SubscriptionUsage.findById(usage._id).lean();
    if (latest?.activeLiveSessionId) {
      throw createUsageError('A Kiara Live session is already active for this account.', 'LIVE_SESSION_ALREADY_ACTIVE', 409);
    }
    throw createUsageError('Your monthly AI voice usage is complete.', 'USAGE_LIMIT_REACHED', 402, {
      plan: plan.id,
      usage: Math.ceil((latest?.liveSeconds || 0) / 60),
      limit: plan.liveMinutes,
      upgradeAvailable: true,
    });
  }

  return { sessionId, created: true };
}

async function getActiveLiveSession(userId) {
  const period = getUtcBillingPeriod();
  const usage = await SubscriptionUsage.findOne({ userId, periodStart: period.periodStart }).lean();
  if (!usage?.activeLiveSessionId || !usage.lastLiveHeartbeatAt) return null;
  const ageMs = Date.now() - new Date(usage.lastLiveHeartbeatAt).getTime();
  if (ageMs >= LIVE_SESSION_STALE_MS) return null;
  return { sessionId: usage.activeLiveSessionId };
}

async function heartbeatLiveSession(userId, sessionId, now = new Date()) {
  const period = getUtcBillingPeriod(now);
  const usage = await SubscriptionUsage.findOne({ userId, periodStart: period.periodStart });
  if (!usage || usage.activeLiveSessionId !== sessionId || !usage.lastLiveHeartbeatAt) {
    throw createUsageError('Live usage session is no longer active.', 'LIVE_SESSION_NOT_ACTIVE', 409);
  }

  const previousHeartbeat = usage.lastLiveHeartbeatAt;
  const elapsedSeconds = Math.max(0, Math.min(
    MAX_LIVE_HEARTBEAT_SECONDS,
    Math.floor((now.getTime() - previousHeartbeat.getTime()) / 1000),
  ));
  if (elapsedSeconds === 0) {
    return { allowed: true, billedSeconds: 0, liveSeconds: usage.liveSeconds };
  }

  const activePlan = await getCurrentSubscription(userId, now);
  const entitlement = activePlan ? toEntitlementPlan(activePlan.planId) : freePlan;
  const maxSeconds = entitlement.liveMinutes === null ? null : entitlement.liveMinutes * 60;
  const { billedSeconds, limitReached: reachedLimit } = calculateLiveCharge(
    elapsedSeconds,
    usage.liveSeconds,
    maxSeconds,
  );
  const updated = await SubscriptionUsage.findOneAndUpdate(
    { _id: usage._id, activeLiveSessionId: sessionId, lastLiveHeartbeatAt: previousHeartbeat },
    {
      $inc: { liveSeconds: billedSeconds },
      $set: {
        lastLiveHeartbeatAt: reachedLimit ? null : now,
        ...(reachedLimit ? { activeLiveSessionId: null } : {}),
      },
    },
    { returnDocument: 'after' },
  );

  if (!updated) {
    return { allowed: true, billedSeconds: 0, liveSeconds: usage.liveSeconds };
  }

  return {
    allowed: !reachedLimit,
    billedSeconds,
    liveSeconds: updated.liveSeconds,
    limitReached: reachedLimit,
    message: reachedLimit ? 'Your monthly AI voice usage is complete.' : undefined,
  };
}

async function endLiveSession(userId, sessionId) {
  const heartbeat = await heartbeatLiveSession(userId, sessionId).catch((error) => {
    if (error.code === 'LIVE_SESSION_NOT_ACTIVE') return null;
    throw error;
  });
  const period = getUtcBillingPeriod();
  const result = await SubscriptionUsage.updateOne(
    { userId, periodStart: period.periodStart, activeLiveSessionId: sessionId },
    { $set: { activeLiveSessionId: null, lastLiveHeartbeatAt: null } },
  );
  return { ended: result.modifiedCount > 0, usage: heartbeat?.liveSeconds ?? null };
}

async function abortLiveSession(userId, sessionId) {
  if (!sessionId) return { ended: false };
  const period = getUtcBillingPeriod();
  const result = await SubscriptionUsage.updateOne(
    { userId, periodStart: period.periodStart, activeLiveSessionId: sessionId },
    { $set: { activeLiveSessionId: null, lastLiveHeartbeatAt: null } },
  );
  return { ended: result.modifiedCount > 0 };
}

module.exports = {
  CHAT_RESERVATION_TTL_MS,
  LIVE_SESSION_STALE_MS,
  abortLiveSession,
  calculateLiveCharge,
  commitChatMessage,
  createUsageError,
  endLiveSession,
  ensureUsageRow,
  getCurrentSubscription,
  getActiveLiveSession,
  getOverview,
  getUtcBillingPeriod,
  heartbeatLiveSession,
  releaseChatReservation,
  reserveChatMessage,
  startLiveSession,
};