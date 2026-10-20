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
      liveMinutesLimit: null,
      chatMessages: usage?.chatMessages || 0,
      chatMessagesLimit: null,
    },
  };
}

async function reserveChatMessage(userId) {
  const now = new Date();
  const period = getUtcBillingPeriod(now);
  const usage = await ensureUsageRow(userId, period);
  const reservationId = randomUUID();
  const expiresAt = new Date(now.getTime() + CHAT_RESERVATION_TTL_MS);

  // Remove expired reservations, then reserve atomically. No plan/monthly message cap.
  await SubscriptionUsage.updateOne(
    { _id: usage._id },
    { $pull: { pendingChatReservations: { expiresAt: { $lte: now } } } },
  );

  const updated = await SubscriptionUsage.findOneAndUpdate(
    { _id: usage._id },
    { $push: { pendingChatReservations: { id: reservationId, expiresAt } } },
    { returnDocument: 'after' },
  );

  if (!updated) {
    throw createUsageError('Unable to reserve an AI chat message. Please retry.', 'CHAT_RESERVATION_FAILED', 503);
  }

  return {
    reservationId,
    usage: updated.chatMessages || 0,
    limit: null,
    plan: 'unlimited',
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
  const usage = await ensureUsageRow(userId, period);
  const isResume = lifecycleTrigger === 'LIVE_TOKEN_REFRESH' || lifecycleTrigger === 'LIVE_SESSION_RECONNECT';
  const activeSessions = Array.isArray(usage.activeLiveSessions) ? usage.activeLiveSessions : [];

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

  // Drop stale sessions without blocking new sessions.
  await SubscriptionUsage.updateOne(
    { _id: usage._id },
    { $pull: { activeLiveSessions: { lastHeartbeatAt: { $lte: new Date(now.getTime() - LIVE_SESSION_STALE_MS) } } } },
  );

  const sessionId = randomUUID();
  const claimed = await SubscriptionUsage.findOneAndUpdate(
    { _id: usage._id },
    { $push: { activeLiveSessions: { sessionId, startedAt: now, lastHeartbeatAt: now } } },
    { returnDocument: 'after' },
  );
  if (!claimed) {
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
    return { allowed: true, billedSeconds: 0, liveSeconds: usage.liveSeconds || 0 };
  }

  // Track usage for analytics, but do not enforce a monthly voice-minute cap.
  const updated = await SubscriptionUsage.findOneAndUpdate(
    {
      _id: usage._id,
      activeLiveSessions: { $elemMatch: { sessionId, lastHeartbeatAt: previousHeartbeat } },
    },
    {
      $inc: { liveSeconds: elapsedSeconds },
      $set: { 'activeLiveSessions.$.lastHeartbeatAt': now },
    },
    { returnDocument: 'after' },
  );

  if (!updated) {
    return { allowed: true, billedSeconds: 0, liveSeconds: usage.liveSeconds || 0 };
  }
  return {
    allowed: true,
    billedSeconds: elapsedSeconds,
    liveSeconds: updated.liveSeconds || 0,
    limitReached: false,
  };
}

async function endLiveSession(userId, sessionId) {
  let heartbeat = null;
  try {
    heartbeat = await heartbeatLiveSession(userId, sessionId);
  } catch (error) {
    if (error.code !== 'LIVE_SESSION_NOT_ACTIVE') throw error;
  }
  const period = getUtcBillingPeriod();
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
  getActiveLiveSession,
  getOverview,
  getUtcBillingPeriod,
  heartbeatLiveSession,
  releaseChatReservation,
  reserveChatMessage,
  startLiveSession,
};