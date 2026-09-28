const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateLiveCharge, getUtcBillingPeriod } = require('./usageService');

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