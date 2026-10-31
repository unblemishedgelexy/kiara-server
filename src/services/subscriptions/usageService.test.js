const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Subscription = require('../../models/Subscription');
const SubscriptionUsage = require('../../models/SubscriptionUsage');
const User = require('../../models/User');
const usageService = require('./usageService');

const {
  calculateLiveCharge,
  getUtcBillingPeriod,
} = usageService;

test('meters only elapsed live seconds, caps delayed heartbeats, and stops at the exact limit', () => {
  assert.deepEqual(calculateLiveCharge(30, 0, 3600), { billedSeconds: 30, limitReached: false });
  assert.deepEqual(calculateLiveCharge(180, 100, 3600), { billedSeconds: 90, limitReached: false });
  assert.deepEqual(calculateLiveCharge(30, 3570, 3600), { billedSeconds: 30, limitReached: true });
  assert.deepEqual(calculateLiveCharge(30, 3590, 3600), { billedSeconds: 10, limitReached: true });
});

test('free entitlement meters usage without enforcing a paid limit', () => {
  assert.deepEqual(calculateLiveCharge(30, 120, null), { billedSeconds: 30, limitReached: false });
});

test('active admin role receives lifetime entitlement without monthly chat or Live limits', async () => {
  const originalUserFindById = User.findById;
  const originalSubscriptionFindOne = Subscription.findOne;
  const originalUsageFindOne = SubscriptionUsage.findOne;
  const originalUsageFindOneAndUpdate = SubscriptionUsage.findOneAndUpdate;
  const originalUsageUpdateOne = SubscriptionUsage.updateOne;
  const originalMaxActiveSessions = require('../../config/env').env.maxActiveLiveSessionsPerAccount;
  const usage = {
    _id: new mongoose.Types.ObjectId(),
    userId: 'admin-user',
    periodStart: getUtcBillingPeriod().periodStart,
    periodEnd: getUtcBillingPeriod().periodEnd,
    liveSeconds: 1_000_000,
    chatMessages: 50_000,
    pendingChatReservations: [],
    activeLiveSessions: [],
  };

  try {
    User.findById = () => ({
      select: () => ({
        lean: async () => ({ role: 'admin', isActive: true }),
      }),
    });
    Subscription.findOne = () => {
      throw new Error('Admin entitlement must not depend on a subscription record or expiry.');
    };
    SubscriptionUsage.findOneAndUpdate = async (_filter, update) => {
      if (update.$setOnInsert) return usage;
      if (update.$push?.pendingChatReservations) {
        usage.pendingChatReservations.push(update.$push.pendingChatReservations);
        return usage;
      }
      if (update.$push?.activeLiveSessions) {
        usage.activeLiveSessions.push(update.$push.activeLiveSessions);
        return usage;
      }
      if (update.$inc?.liveSeconds) {
        usage.liveSeconds += update.$inc.liveSeconds;
        usage.activeLiveSessions[0].lastHeartbeatAt = update.$set['activeLiveSessions.$.lastHeartbeatAt'];
        return usage;
      }
      return null;
    };
    SubscriptionUsage.findOne = async () => usage;
    SubscriptionUsage.updateOne = async () => ({ modifiedCount: 0 });

    const overview = await usageService.getOverview('admin-user');
    assert.equal(overview.isAdmin, true);
    assert.equal(overview.status, 'admin');
    assert.equal(overview.currentPlan.id, 'admin');
    assert.equal(overview.currentPlan.name, 'Admin Lifetime');
    assert.equal(overview.currentPlan.liveMinutes, null);
    assert.equal(overview.currentPlan.chatMessages, null);
    assert.equal(overview.usage.liveMinutesLimit, null);
    assert.equal(overview.usage.chatMessagesLimit, null);
    assert.equal(overview.subscription, null);

    const chat = await usageService.reserveChatMessage('admin-user');
    assert.equal(chat.plan, 'admin');
    assert.equal(chat.limit, null);

    const live = await usageService.startLiveSession('admin-user');
    assert.equal(live.created, true);
    assert.ok(live.sessionId);
    const heartbeat = await usageService.heartbeatLiveSession(
      'admin-user',
      live.sessionId,
      new Date(Date.now() + 30_000),
    );
    assert.equal(heartbeat.allowed, true);
    assert.equal(heartbeat.limitReached, false);
    assert.equal(heartbeat.billedSeconds, 30);
  } finally {
    User.findById = originalUserFindById;
    Subscription.findOne = originalSubscriptionFindOne;
    SubscriptionUsage.findOne = originalUsageFindOne;
    SubscriptionUsage.findOneAndUpdate = originalUsageFindOneAndUpdate;
    SubscriptionUsage.updateOne = originalUsageUpdateOne;
    require('../../config/env').env.maxActiveLiveSessionsPerAccount = originalMaxActiveSessions;
  }
});

test('paid chat quota is checked atomically against completed and pending messages', async () => {
  const usageId = new mongoose.Types.ObjectId();
  const usage = {
    _id: usageId,
    userId: 'user-2',
    periodStart: getUtcBillingPeriod().periodStart,
    periodEnd: getUtcBillingPeriod().periodEnd,
    chatMessages: 300,
    pendingChatReservations: [],
    activeLiveSessions: [],
  };
  const originals = {
    userFindById: User.findById,
    subscriptionFindOne: Subscription.findOne,
    usageFindOneAndUpdate: SubscriptionUsage.findOneAndUpdate,
    usageUpdateOne: SubscriptionUsage.updateOne,
    usageFindById: SubscriptionUsage.findById,
  };

  try {
    User.findById = () => ({
      select: () => ({
        lean: async () => ({ role: 'user', isActive: true }),
      }),
    });
    Subscription.findOne = () => ({
      sort: () => ({
        lean: async () => ({
          userId: 'user-2',
          planId: 'starter',
          status: 'active',
          expiresAt: new Date(Date.now() + 60_000),
        }),
      }),
    });
    SubscriptionUsage.findOneAndUpdate = async (_filter, update) => (
      update.$setOnInsert ? usage : null
    );
    SubscriptionUsage.updateOne = async () => ({ modifiedCount: 0 });
    SubscriptionUsage.findById = () => ({ lean: async () => usage });

    await assert.rejects(
      usageService.reserveChatMessage('user-2'),
      (error) => {
        assert.equal(error.code, 'CHAT_QUOTA_EXCEEDED');
        assert.equal(error.statusCode, 402);
        assert.equal(error.details.usage, 300);
        assert.equal(error.details.limit, 300);
        return true;
      },
    );
  } finally {
    User.findById = originals.userFindById;
    Subscription.findOne = originals.subscriptionFindOne;
    SubscriptionUsage.findOneAndUpdate = originals.usageFindOneAndUpdate;
    SubscriptionUsage.updateOne = originals.usageUpdateOne;
    SubscriptionUsage.findById = originals.usageFindById;
  }
});

test('paid live quota blocks new sessions at the plan boundary', async () => {
  const usageId = new mongoose.Types.ObjectId();
  const usage = {
    _id: usageId,
    userId: 'user-3',
    periodStart: getUtcBillingPeriod().periodStart,
    periodEnd: getUtcBillingPeriod().periodEnd,
    liveSeconds: 3600,
    chatMessages: 0,
    activeLiveSessions: [],
  };
  const originals = {
    userFindById: User.findById,
    subscriptionFindOne: Subscription.findOne,
    usageFindOneAndUpdate: SubscriptionUsage.findOneAndUpdate,
    usageUpdateOne: SubscriptionUsage.updateOne,
    usageFindById: SubscriptionUsage.findById,
  };

  try {
    User.findById = () => ({
      select: () => ({
        lean: async () => ({ role: 'user', isActive: true }),
      }),
    });

    Subscription.findOne = () => ({
      sort: () => ({
        lean: async () => ({
          userId: 'user-3',
          planId: 'starter',
          status: 'active',
          expiresAt: new Date(Date.now() + 60_000),
        }),
      }),
    });
    SubscriptionUsage.findOneAndUpdate = async (_filter, update) => (
      update.$setOnInsert ? usage : null
    );
    SubscriptionUsage.updateOne = async () => ({ modifiedCount: 0 });
    SubscriptionUsage.findById = () => ({ lean: async () => usage });

    await assert.rejects(
      usageService.startLiveSession('user-3'),
      (error) => {
        assert.equal(error.code, 'LIVE_QUOTA_EXCEEDED');
        assert.equal(error.statusCode, 402);
        assert.equal(error.details.limitSeconds, 3600);
        return true;
      },
    );
  } finally {
    User.findById = originals.userFindById;
    Subscription.findOne = originals.subscriptionFindOne;
    SubscriptionUsage.findOneAndUpdate = originals.usageFindOneAndUpdate;
    SubscriptionUsage.updateOne = originals.usageUpdateOne;
    SubscriptionUsage.findById = originals.usageFindById;
  }
});

test('MongoDB usage-store outage fails closed before a Live session can be admitted', async () => {
  const originalUserFindById = User.findById;
  const originalUsageFindOneAndUpdate = SubscriptionUsage.findOneAndUpdate;
  const originalSubscriptionFindOne = Subscription.findOne;
  const databaseError = new Error('simulated MongoDB outage');
  let subscriptionLookupCount = 0;

  try {
    User.findById = () => ({
      select: () => ({
        lean: async () => ({ role: 'user', isActive: true }),
      }),
    });
    SubscriptionUsage.findOneAndUpdate = async () => {
      throw databaseError;
    };
    Subscription.findOne = () => {
      subscriptionLookupCount += 1;
      throw new Error('Subscription lookup must not follow failed usage admission.');
    };

    await assert.rejects(
      usageService.startLiveSession('mongo-outage-user'),
      (error) => error === databaseError,
    );
    assert.equal(subscriptionLookupCount, 0);
  } finally {
    User.findById = originalUserFindById;
    SubscriptionUsage.findOneAndUpdate = originalUsageFindOneAndUpdate;
    Subscription.findOne = originalSubscriptionFindOne;
  }
});

test('billing periods use UTC month boundaries', () => {
  const { periodStart, periodEnd } = getUtcBillingPeriod(new Date('2026-09-27T19:00:00.000Z'));
  assert.equal(periodStart.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(periodEnd.toISOString(), '2026-10-01T00:00:00.000Z');
});

test('clears stale live sessions before creating the next one', async () => {
  const now = new Date('2026-09-15T12:00:00.000Z');
  const staleSessionId = 'stale-session';
  const freshSessionId = 'fresh-session';
  const usageId = new mongoose.Types.ObjectId();
  const previousUsage = {
    _id: usageId,
    userId: 'user-1',
    periodStart: new Date('2026-09-01T00:00:00.000Z'),
    periodEnd: new Date('2026-10-01T00:00:00.000Z'),
    liveSeconds: 120,
    chatMessages: 0,
    activeLiveSessions: [{
      sessionId: staleSessionId,
      startedAt: new Date('2026-09-15T11:00:00.000Z'),
      lastHeartbeatAt: new Date('2026-09-15T11:20:00.000Z'),
    }],
  };

  const originalFindOne = Subscription.findOne;
  const originalUserFindById = User.findById;
  const originalUsageFindOne = SubscriptionUsage.findOne;
  const originalUsageFindOneAndUpdate = SubscriptionUsage.findOneAndUpdate;
  const originalUsageUpdateOne = SubscriptionUsage.updateOne;
  const originalUsageFindById = SubscriptionUsage.findById;

  try {
    User.findById = () => ({
      select: () => ({
        lean: async () => ({ role: 'user', isActive: true }),
      }),
    });
    Subscription.findOne = () => ({
      sort: () => ({
        lean: async () => ({
          userId: 'user-1',
          planId: 'starter',
          status: 'active',
          expiresAt: new Date('2026-12-31T00:00:00.000Z'),
        }),
      }),
    });

    SubscriptionUsage.findOne = async (filter) => {
      if (filter.userId === 'user-1' && filter.periodStart) {
        return previousUsage;
      }
      return null;
    };

    SubscriptionUsage.findOneAndUpdate = async (filter, update) => {
      if (filter.userId === 'user-1' && filter.periodStart) {
        return { ...previousUsage };
      }

      if (
        filter._id &&
        String(filter._id) === String(usageId) &&
        update.$inc?.liveSeconds
      ) {
        return {
          ...previousUsage,
          liveSeconds: previousUsage.liveSeconds + update.$inc.liveSeconds,
          activeLiveSessions: [{
            ...previousUsage.activeLiveSessions[0],
            lastHeartbeatAt: now,
          }],
        };
      }

      if (filter._id && String(filter._id) === String(usageId) && update.$push?.activeLiveSessions) {
        return {
          ...previousUsage,
          activeLiveSessions: [{
            sessionId: freshSessionId,
            startedAt: now,
            lastHeartbeatAt: now,
          }],
        };
      }

      return null;
    };

    SubscriptionUsage.updateOne = async (filter, update) => {
      if (
        filter._id &&
        String(filter._id) === String(usageId) &&
        update.$pull?.activeLiveSessions
      ) {
        return { modifiedCount: 1 };
      }
      return { modifiedCount: 0 };
    };
    SubscriptionUsage.findById = () => ({ lean: async () => previousUsage });

    const result = await usageService.startLiveSession('user-1', 'LIVE_SESSION_START', now);
    assert.equal(result.created, true);
    assert.notEqual(result.sessionId, staleSessionId);
    assert.equal(typeof result.sessionId, 'string');
    assert.ok(result.sessionId.length > 0);
  } finally {
    User.findById = originalUserFindById;
    Subscription.findOne = originalFindOne;
    SubscriptionUsage.findOne = originalUsageFindOne;
    SubscriptionUsage.findOneAndUpdate = originalUsageFindOneAndUpdate;
    SubscriptionUsage.updateOne = originalUsageUpdateOne;
    SubscriptionUsage.findById = originalUsageFindById;
  }
});