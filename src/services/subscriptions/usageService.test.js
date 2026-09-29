const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Subscription = require('../../models/Subscription');
const SubscriptionUsage = require('../../models/SubscriptionUsage');
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

test('billing periods use UTC month boundaries', () => {
  const { periodStart, periodEnd } = getUtcBillingPeriod(new Date('2026-09-27T19:00:00.000Z'));
  assert.equal(periodStart.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(periodEnd.toISOString(), '2026-10-01T00:00:00.000Z');
});

test('clears a stale live session before creating the next one', async () => {
  const now = new Date('2026-09-15T12:00:00.000Z');
  const staleSessionId = 'stale-session';
  const usageId = new mongoose.Types.ObjectId();
  const previousUsage = {
    _id: usageId,
    userId: 'user-1',
    periodStart: new Date('2026-09-01T00:00:00.000Z'),
    periodEnd: new Date('2026-10-01T00:00:00.000Z'),
    liveSeconds: 120,
    chatMessages: 0,
    activeLiveSessionId: staleSessionId,
    lastLiveHeartbeatAt: new Date('2026-09-15T11:20:00.000Z'),
  };

  const originalFindOne = Subscription.findOne;
  const originalUsageFindOne = SubscriptionUsage.findOne;
  const originalUsageFindOneAndUpdate = SubscriptionUsage.findOneAndUpdate;
  const originalUsageUpdateOne = SubscriptionUsage.updateOne;

  try {
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

      if (filter._id && String(filter._id) === String(usageId) && filter.activeLiveSessionId === staleSessionId) {
        return { ...previousUsage, activeLiveSessionId: null, lastLiveHeartbeatAt: null };
      }

      if (filter._id && String(filter._id) === String(usageId) && filter.activeLiveSessionId === null) {
        return {
          ...previousUsage,
          activeLiveSessionId: 'fresh-session',
          lastLiveHeartbeatAt: now,
        };
      }

      return null;
    };

    SubscriptionUsage.updateOne = async (filter, update) => {
      if (filter._id && String(filter._id) === String(usageId) && filter.activeLiveSessionId === staleSessionId) {
        return { modifiedCount: 1 };
      }
      return { modifiedCount: 0 };
    };

    const result = await usageService.startLiveSession('user-1', 'LIVE_SESSION_START', now);
    assert.equal(result.created, true);
    assert.notEqual(result.sessionId, staleSessionId);
    assert.equal(typeof result.sessionId, 'string');
    assert.ok(result.sessionId.length > 0);
  } finally {
    Subscription.findOne = originalFindOne;
    SubscriptionUsage.findOne = originalUsageFindOne;
    SubscriptionUsage.findOneAndUpdate = originalUsageFindOneAndUpdate;
    SubscriptionUsage.updateOne = originalUsageUpdateOne;
  }
});