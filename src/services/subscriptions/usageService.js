const { randomUUID } = require('crypto');
const Subscription = require('../../models/Subscription');
const SubscriptionUsage = require('../../models/SubscriptionUsage');
const User = require('../../models/User');
const { findPaidPlan, freePlan, getPublicPlans, toEntitlementPlan } = require('../../config/subscriptionPlans');
const { env } = require('../../config/env');
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

async function isAdminUser(userId) {
  const user = await User.findById(userId).select('role isActive').lean();
  return Boolean(user?.isActive && user.role === 'admin');
}

async function getOverview(userId, now = new Date()) {
  const period = getUtcBillingPeriod(now);
  const admin = await isAdminUser(userId);
  if (admin) {
    const usage = await ensureUsageRow(userId, period);
    return {
      checkoutAvailable: false,
      currentPlan: {
        id: 'admin',
        name: 'Admin Lifetime',
        priceInr: 0,
        currency: 'INR',
        liveMinutes: null,
        chatMessages: null,
      },
      isAdmin: true,
      plans: getPublicPlans(),
      status: 'admin',
      subscription: null,
      usage: {
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        liveSeconds: usage?.liveSeconds || 0,
        liveMinutes: Math.floor((usage?.liveSeconds || 0) / 60),
        liveMinutesLimit: null,
        chatMessages: usage?.chatMessages || 0,
        chatMessagesLimit: null,
      },
    };
  }

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
    isAdmin: false,
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
      liveMinutesLimit: currentPaidPlan?.liveMinutes ?? null,
      chatMessages: usage?.chatMessages || 0,
      chatMessagesLimit: currentPaidPlan?.chatMessages ?? null,
    },
  };
}

async function reserveChatMessage(userId) {
  const now = new Date();
  const period = getUtcBillingPeriod(now);
  const admin = await isAdminUser(userId);
  const [usage, subscription] = await Promise.all([
    ensureUsageRow(userId, period),
    admin ? null : getCurrentSubscription(userId, now),
  ]);
  const plan = !admin && subscription ? findPaidPlan(subscription.planId) : null;
  const limit = plan?.chatMessages ?? null;
  const reservationId = randomUUID();
  const expiresAt = new Date(now.getTime() + CHAT_RESERVATION_TTL_MS);

  await SubscriptionUsage.updateOne(
    { _id: usage._id },
    { $pull: { pendingChatReservations: { expiresAt: { $lte: now } } } },
  );

  const filter = { _id: usage._id };
  if (limit !== null) {
    filter.$expr = {
      $lt: [
        {
          $add: [
            { $ifNull: ['$chatMessages', 0] },
            { $size: { $ifNull: ['$pendingChatReservations', []] } },
          ],
        },
        limit,
      ],
    };
  }
  const updated = await SubscriptionUsage.findOneAndUpdate(
    filter,
    { $push: { pendingChatReservations: { id: reservationId, expiresAt } } },
    { returnDocument: 'after' },
  );

  if (!updated) {
    const latest = await SubscriptionUsage.findById(usage._id).lean();
    const activeReservations = (latest?.pendingChatReservations || [])
      .filter((reservation) => reservation.expiresAt > now).length;
    const currentUsage = (latest?.chatMessages || 0) + activeReservations;
    if (limit !== null && currentUsage >= limit) {
      throw createUsageError(
        'The monthly AI chat message limit for this plan has been reached.',
        'CHAT_QUOTA_EXCEEDED',
        402,
        { usage: currentUsage, limit, plan: plan.id },
      );
    }
    throw createUsageError('Unable to reserve an AI chat message. Please retry.', 'CHAT_RESERVATION_FAILED', 503);
  }

  return {
    reservationId,
    usage: (updated.chatMessages || 0) + (updated.pendingChatReservations || []).length,
    limit,
    plan: admin ? 'admin' : plan?.id || 'free',
  };
}

async function commitChatMessage(userId, reservationId) {
  const now = new Date();
  const result = await SubscriptionUsage.findOneAndUpdate(
    {
      userId,
      pendingChatReservations: {
        $elemMatch: { id: reservationId, expiresAt: { $gt: now } },
      },
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
  const admin = await isAdminUser(userId);
  const usage = await ensureUsageRow(userId, period);
  const subscription = admin ? null : await getCurrentSubscription(userId, now);
  const plan = subscription ? findPaidPlan(subscription.planId) : null;
  const maxLiveSeconds = plan ? plan.liveMinutes * 60 : null;
  const isResume = lifecycleTrigger === 'LIVE_TOKEN_REFRESH' || lifecycleTrigger === 'LIVE_SESSION_RECONNECT';
  const storedSessions = Array.isArray(usage.activeLiveSessions) ? usage.activeLiveSessions : [];
  const staleSessions = storedSessions.filter((session) =>
    !session.lastHeartbeatAt
    || new Date(session.lastHeartbeatAt).getTime() <= now.getTime() - LIVE_SESSION_STALE_MS
  );
  for (const session of staleSessions) {
    try {
      await endLiveSession(userId, session.sessionId, now);
    } catch (error) {
      if (error.code !== 'LIVE_SESSION_NOT_ACTIVE') throw error;
      await abortLiveSession(userId, session.sessionId);
    }
  }
  const activeSessions = storedSessions.filter((session) => !staleSessions.includes(session));

  // A reconnect/refresh reuses an existing live session if one exists.
  // A normal start always creates a separate session, allowing multiple tabs/devices.
  if (isResume && activeSessions.length) {
    const resumable = [...activeSessions].sort((a, b) =>
      new Date(b.lastHeartbeatAt || b.startedAt || 0) - new Date(a.lastHeartbeatAt || a.startedAt || 0)
    )[0];
    const ageMs = resumable.lastHeartbeatAt
      ? now.getTime() - new Date(resumable.lastHeartbeatAt).getTime()
      : Infinity;
    if (resumable.sessionId && ageMs < LIVE_SESSION_STALE_MS) {
      await SubscriptionUsage.updateOne(
        { _id: usage._id, 'activeLiveSessions.sessionId': resumable.sessionId },
        { $set: { 'activeLiveSessions.$.lastHeartbeatAt': now } },
      );
      return { sessionId: resumable.sessionId, created: false };
    }
  }

  const sessionId = randomUUID();
  const claimFilter = { _id: usage._id };
  const admissionChecks = [
    {
      $lt: [
        { $size: { $ifNull: ['$activeLiveSessions', []] } },
        env.maxActiveLiveSessionsPerAccount,
      ],
    },
  ];
  if (maxLiveSeconds !== null) {
    admissionChecks.push({
      $lt: [{ $ifNull: ['$liveSeconds', 0] }, maxLiveSeconds],
    });
  }
  claimFilter.$expr = { $and: admissionChecks };
  const claimed = await SubscriptionUsage.findOneAndUpdate(
    claimFilter,
    { $push: { activeLiveSessions: { sessionId, startedAt: now, lastHeartbeatAt: now } } },
    { returnDocument: 'after' },
  );
  if (!claimed) {
    const latest = await SubscriptionUsage.findById(usage._id).lean();
    if (maxLiveSeconds !== null && (latest?.liveSeconds || 0) >= maxLiveSeconds) {
      throw createUsageError(
        'The monthly Gemini Live voice limit for this plan has been reached.',
        'LIVE_QUOTA_EXCEEDED',
        402,
        { liveSeconds: latest?.liveSeconds || 0, limitSeconds: maxLiveSeconds, plan: plan.id },
      );
    }
    const activeCount = (latest?.activeLiveSessions || []).filter((session) =>
      session.lastHeartbeatAt && new Date(session.lastHeartbeatAt).getTime() > now.getTime() - LIVE_SESSION_STALE_MS
    ).length;
    if (activeCount >= env.maxActiveLiveSessionsPerAccount) {
      throw createUsageError(
        'The maximum number of active Kiara Live sessions has been reached.',
        'ACTIVE_LIVE_SESSION_LIMIT',
        429,
        { limit: env.maxActiveLiveSessionsPerAccount },
      );
    }
    throw createUsageError('Unable to start a Kiara Live session. Please retry.', 'LIVE_SESSION_START_FAILED', 503);
  }
  return { sessionId, created: true };
}

async function getActiveLiveSession(userId) {
  const period = getUtcBillingPeriod();
  const usage = await SubscriptionUsage.findOne({ userId, periodStart: period.periodStart }).lean();
  if (!usage) return null;
  const cutoff = Date.now() - LIVE_SESSION_STALE_MS;
  const sessions = (usage.activeLiveSessions || []).filter((session) =>
    session.sessionId && session.lastHeartbeatAt && new Date(session.lastHeartbeatAt).getTime() > cutoff
  );
  if (!sessions.length) return null;
  return {
    // Keep the old singular property for clients that expect it.
    sessionId: sessions[0].sessionId,
    sessions: sessions.map(({ sessionId, startedAt, lastHeartbeatAt }) => ({ sessionId, startedAt, lastHeartbeatAt })),
  };
}

async function heartbeatLiveSession(userId, sessionId, now = new Date()) {
  const period = getUtcBillingPeriod(now);
  const admin = await isAdminUser(userId);
  const subscription = admin ? null : await getCurrentSubscription(userId, now);
  const plan = subscription ? findPaidPlan(subscription.planId) : null;
  const maxLiveSeconds = plan ? plan.liveMinutes * 60 : null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const usage = await SubscriptionUsage.findOne({ userId, periodStart: period.periodStart });
    const session = usage?.activeLiveSessions?.find((item) => item.sessionId === sessionId);
    if (!usage || !session || !session.lastHeartbeatAt) {
      throw createUsageError('Live usage session is no longer active.', 'LIVE_SESSION_NOT_ACTIVE', 409);
    }

    const previousHeartbeat = new Date(session.lastHeartbeatAt);
    const elapsedSeconds = Math.max(0, Math.min(
      MAX_LIVE_HEARTBEAT_SECONDS,
      Math.floor((now.getTime() - previousHeartbeat.getTime()) / 1000),
    ));
    if (elapsedSeconds === 0) {
      return { allowed: true, billedSeconds: 0, liveSeconds: usage.liveSeconds || 0, limitReached: false };
    }

    const charge = calculateLiveCharge(elapsedSeconds, usage.liveSeconds || 0, maxLiveSeconds);
    if (charge.billedSeconds === 0 && charge.limitReached) {
      await abortLiveSession(userId, sessionId);
      return {
        allowed: false,
        billedSeconds: 0,
        liveSeconds: usage.liveSeconds || 0,
        limitReached: true,
        limitSeconds: maxLiveSeconds,
      };
    }

    const filter = {
      _id: usage._id,
      activeLiveSessions: { $elemMatch: { sessionId, lastHeartbeatAt: previousHeartbeat } },
    };
    if (maxLiveSeconds !== null) {
      filter.$expr = {
        $lte: [
          { $add: [{ $ifNull: ['$liveSeconds', 0] }, charge.billedSeconds] },
          maxLiveSeconds,
        ],
      };
    }
    const updated = await SubscriptionUsage.findOneAndUpdate(
      filter,
      {
        $inc: { liveSeconds: charge.billedSeconds },
        $set: { 'activeLiveSessions.$.lastHeartbeatAt': now },
      },
      { returnDocument: 'after' },
    );
    if (updated) {
      const total = updated.liveSeconds || 0;
      const limitReached = maxLiveSeconds !== null && total >= maxLiveSeconds;
      if (limitReached) await abortLiveSession(userId, sessionId);
      return {
        allowed: !limitReached,
        billedSeconds: charge.billedSeconds,
        liveSeconds: total,
        limitReached,
        ...(maxLiveSeconds === null ? {} : { limitSeconds: maxLiveSeconds }),
      };
    }
  }

  throw createUsageError('Live usage changed during the heartbeat. Please retry.', 'LIVE_HEARTBEAT_CONFLICT', 409);
}

async function endLiveSession(userId, sessionId, now = new Date()) {
  let heartbeat = null;
  try {
    heartbeat = await heartbeatLiveSession(userId, sessionId, now);
  } catch (error) {
    if (error.code !== 'LIVE_SESSION_NOT_ACTIVE') throw error;
  }
  const period = getUtcBillingPeriod(now);
  const result = await SubscriptionUsage.updateOne(
    { userId, periodStart: period.periodStart, 'activeLiveSessions.sessionId': sessionId },
    { $pull: { activeLiveSessions: { sessionId } } },
  );
  return { ended: result.modifiedCount > 0, usage: heartbeat?.liveSeconds ?? null };
}

async function abortLiveSession(userId, sessionId) {
  if (!sessionId) return { ended: false };
  const period = getUtcBillingPeriod();
  const result = await SubscriptionUsage.updateOne(
    { userId, periodStart: period.periodStart, 'activeLiveSessions.sessionId': sessionId },
    { $pull: { activeLiveSessions: { sessionId } } },
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
  isAdminUser,
  getActiveLiveSession,
  getOverview,
  getUtcBillingPeriod,
  heartbeatLiveSession,
  releaseChatReservation,
  reserveChatMessage,
  startLiveSession,
};