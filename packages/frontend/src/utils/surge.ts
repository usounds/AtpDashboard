/**
 * Surge and anomaly calculation utilities for Explore dashboard.
 * Separates user-surge (new user adoption) from record-surge (activity/usage volume).
 */

/**
 * Calculates user-surge metrics for New User Surge detection.
 * Compares past 72h daily users against normal historical baseline daily users.
 * Uses strictly user (unique DID) counts.
 */
export function calculateUserSurge(
  uniqueDid?: number,
  recentUniqueDid?: number,
  minCreatedAt?: string | null,
  nowMs: number = Date.now()
): {
  multiplier: number;
  recentDaily: number;
  normalDaily: number;
  netGain: number;
} | null {
  const total = uniqueDid || 0;
  const recent = recentUniqueDid || 0;

  // Minimum threshold: at least 3 total users and at least 2 recent users
  if (total < 3 || recent < 2) {
    return null;
  }

  const minTime =
    minCreatedAt && !minCreatedAt.startsWith('1900-01-01')
      ? new Date(minCreatedAt.endsWith('Z') ? minCreatedAt : `${minCreatedAt}Z`).getTime()
      : nowMs;

  const totalDays = Math.max(0.1, (nowMs - minTime) / (1000 * 60 * 60 * 24));

  // Baseline observation window: at least 14 days so newly introduced features
  // (like tokimeki's theme) have a stable baseline rather than dividing by a tiny 1-day launch window.
  const normalDays = Math.max(14, totalDays - 3);
  const pastUsers = Math.max(0, total - recent);
  const rawNormalDaily = pastUsers / normalDays;

  // Baseline floor: Set a minimum baseline expectation of 0.5 users/day (1 user per 2 days / 1.5 users per 72h).
  // This prevents dormant or rarely-used apps from inflating multipliers with tiny sample sizes.
  const normalDaily = Math.max(0.5, rawNormalDaily);
  const recentDaily = recent / 3;

  const multiplier = recentDaily / normalDaily;

  // Must be a noticeable surge: at least 1.5x normal daily rate
  if (multiplier < 1.5) {
    return null;
  }

  // Net extra users gained in 72h above normal expected baseline
  const expectedUsers72h = normalDaily * 3;
  const netGain = Math.max(0, recent - expectedUsers72h);

  return {
    multiplier,
    recentDaily,
    normalDaily,
    netGain,
  };
}

/**
 * Calculates record-surge metrics for Active Buzz (Record Activity) detection.
 * Compares past 72h daily records against historical normal daily records.
 * 
 * STRICT ANTI-BOT GUARD: Requires at least 5 distinct active users (DIDs)
 * in the past 72h to ensure single-bot scripts or automated scrapers cannot spam
 * millions of records into the trending list.
 */
export function calculateRecordSurge(
  count?: number,
  recentCount?: number,
  uniqueDid?: number,
  recentUniqueDid?: number,
  minCreatedAt?: string | null,
  nowMs: number = Date.now()
): {
  multiplier: number;
  recentDailyRecords: number;
  normalDailyRecords: number;
  netGainRecords: number;
  recentRecords: number;
  totalRecords: number;
  recentUsers: number;
} | null {
  const recentUsers = recentUniqueDid || 0;

  // Anti-bot guard: at least 5 unique users must have written records in past 72h
  if (recentUsers < 5) {
    return null;
  }

  const total = count || 0;
  const recent = recentCount || 0;

  // Minimum record thresholds: at least 15 total and 10 recent
  if (total < 15 || recent < 10) {
    return null;
  }

  const minTime =
    minCreatedAt && !minCreatedAt.startsWith('1900-01-01')
      ? new Date(minCreatedAt.endsWith('Z') ? minCreatedAt : `${minCreatedAt}Z`).getTime()
      : nowMs;

  const totalDays = Math.max(0.1, (nowMs - minTime) / (1000 * 60 * 60 * 24));
  const normalDays = Math.max(14, totalDays - 3);
  const pastRecords = Math.max(0, total - recent);
  const rawNormalDaily = pastRecords / normalDays;

  // Baseline floor of 5.0 records/day (15 records per 72h) to avoid small sample multiplier inflation
  const normalDailyRecords = Math.max(5.0, rawNormalDaily);
  const recentDailyRecords = recent / 3;

  const multiplier = recentDailyRecords / normalDailyRecords;

  // Must be a noticeable surge: at least 1.5x normal daily rate
  if (multiplier < 1.5) {
    return null;
  }

  const expectedRecords72h = normalDailyRecords * 3;
  const netGainRecords = Math.max(0, recent - expectedRecords72h);

  return {
    multiplier,
    recentDailyRecords,
    normalDailyRecords,
    netGainRecords,
    recentRecords: recent,
    totalRecords: total,
    recentUsers,
  };
}
