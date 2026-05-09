import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDailySummaryQuery, parseDailySummaryLimit } from './daily-summary.ts';

test('parses daily summary limit safely', () => {
  assert.equal(parseDailySummaryLimit(undefined), 30);
  assert.equal(parseDailySummaryLimit('7'), 7);
  assert.equal(parseDailySummaryLimit('999'), 365);
  assert.equal(parseDailySummaryLimit('bad'), 30);
});

test('active collection summary excludes lexicon store and counts distinct collections', () => {
  const sql = buildDailySummaryQuery('active_collection');

  assert.match(sql, /uniqExact\(collection\) AS count/);
  assert.match(sql, /toUInt16\(arrayJoin\(range\(1, limit_days \+ 1\)\)\) AS day/);
  assert.match(sql, /SELECT max\(created_at\)/);
  assert.match(sql, /toUInt16\(intDiv\(dateDiff\('second', created_at, latest_at\), 86400\) \+ 1\) AS day/);
  assert.match(sql, /created_at > latest_at - toIntervalDay\(limit_days\)/);
  assert.match(sql, /did != \{excluded_did:String\}/);
  assert.match(sql, /ORDER BY day ASC/);
});

test('active did summary counts distinct dids without lexicon exclusion', () => {
  const sql = buildDailySummaryQuery('active_did');

  assert.match(sql, /uniqExact\(did\) AS count/);
  assert.doesNotMatch(sql, /did != \{excluded_did:String\}/);
});

test('new collection summary groups by first seen collection day', () => {
  const sql = buildDailySummaryQuery('new_collection');

  assert.match(sql, /min\(created_at\) AS first_seen_at/);
  assert.match(sql, /toUInt16\(intDiv\(dateDiff\('second', first_seen_at, latest_at\), 86400\) \+ 1\) AS day/);
  assert.match(sql, /first_seen_at > latest_at - toIntervalDay\(limit_days\)/);
  assert.match(sql, /GROUP BY collection/);
  assert.match(sql, /count\(\) AS count/);
});
