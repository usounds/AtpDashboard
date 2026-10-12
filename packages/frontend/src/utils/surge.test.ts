import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateUserSurge, calculateRecordSurge } from './surge.ts';

test('calculateUserSurge: returns null when total users < 3 or recent users < 2', () => {
  assert.equal(calculateUserSurge(2, 2, '2025-01-01T00:00:00Z'), null);
  assert.equal(calculateUserSurge(10, 1, '2025-01-01T00:00:00Z'), null);
  assert.equal(calculateUserSurge(0, 0, null), null);
});

test('calculateUserSurge: filters out dormant app with only 2 users in 72h due to baseline floor (0.5/day)', () => {
  const nowMs = new Date('2026-10-12T00:00:00Z').getTime();
  const minCreatedAt = new Date('2026-07-01T00:00:00Z').toISOString();
  const result = calculateUserSurge(4, 2, minCreatedAt, nowMs);
  assert.equal(result, null);
});

test('calculateUserSurge: caps multiplier inflation on dormant app with 3 users to 2.0x instead of double digits', () => {
  const nowMs = new Date('2026-10-12T00:00:00Z').getTime();
  const minCreatedAt = new Date('2026-07-01T00:00:00Z').toISOString();
  const result = calculateUserSurge(5, 3, minCreatedAt, nowMs);
  assert.ok(result !== null);
  assert.equal(result.multiplier, 2.0);
  assert.equal(result.normalDaily, 0.5);
  assert.equal(result.recentDaily, 1.0);
  assert.equal(result.netGain, 1.5);
});

test('calculateUserSurge: accurately measures viral breakout app with significant users', () => {
  const nowMs = new Date('2026-10-12T00:00:00Z').getTime();
  const minCreatedAt = new Date('2026-09-12T00:00:00Z').toISOString();
  const result = calculateUserSurge(515, 153, minCreatedAt, nowMs);
  assert.ok(result !== null);
  assert.ok(result.multiplier > 3.5);
  assert.equal(result.recentDaily, 51);
  assert.ok(result.normalDaily > 10);
  assert.ok(result.netGain > 100);
});

test('calculateUserSurge: preserves surge detection for newly launched features with 14-day minimum window', () => {
  const nowMs = new Date('2026-10-12T00:00:00Z').getTime();
  const minCreatedAt = new Date('2026-10-09T00:00:00Z').toISOString();
  const result = calculateUserSurge(15, 6, minCreatedAt, nowMs);
  assert.ok(result !== null);
  assert.equal(result.recentDaily, 2);
  assert.ok(result.multiplier >= 3.0 && result.multiplier <= 3.2);
});

test('calculateRecordSurge: anti-bot guard rejects high-volume records if recent unique users < 5', () => {
  // 1 bot writing 50,000 records
  const result = calculateRecordSurge(100000, 50000, 1, 1, '2025-01-01T00:00:00Z');
  assert.equal(result, null);

  // 4 users writing 10,000 records
  const result4 = calculateRecordSurge(10000, 5000, 4, 4, '2025-01-01T00:00:00Z');
  assert.equal(result4, null);
});

test('calculateRecordSurge: rejects schemas with negligible records', () => {
  const result = calculateRecordSurge(10, 5, 10, 6, '2025-01-01T00:00:00Z');
  assert.equal(result, null);
});

test('calculateRecordSurge: detects legitimate record activity buzz across multiple users', () => {
  // e.g. 2000 recent records across 64 users, 16000 total records, created 90 days ago
  const nowMs = new Date('2026-10-12T00:00:00Z').getTime();
  const minCreatedAt = new Date('2026-07-12T00:00:00Z').toISOString();
  const result = calculateRecordSurge(16000, 2000, 800, 64, minCreatedAt, nowMs);
  assert.ok(result !== null);
  assert.ok(result.multiplier > 3.0);
  assert.equal(result.recentUsers, 64);
  assert.ok(result.recentDailyRecords > 600);
  assert.ok(result.netGainRecords > 1000);
});
