import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COLLECTION_COUNT_INCREMENTAL_LOCK_PATH,
  QueueSequenceGenerator,
  assertNonEmptyQueueSeq,
  buildCanonicalPayloadTuple,
  buildPayloadHash,
  buildQueueCursorPredicate,
  compareQueueCursor,
  ensureQueueCursorAfterCutoffs,
  isQueueCursorAfter,
} from './collection-count-incremental.ts';

test('builds stable canonical payload tuple and hash', () => {
  const input = {
    collection: 'app.example.post',
    did: 'did:plc:example',
    rkey: 'abc',
    createdAt: '2026-05-09T14:34:10.123456+09:00',
  };

  assert.deepEqual(buildCanonicalPayloadTuple(input), {
    collection: 'app.example.post',
    did: 'did:plc:example',
    rkey: 'abc',
    createdAtKey: '2026-05-09T05:34:10.123456Z',
    createdHourKey: '2026-05-09T05:00:00Z',
  });
  assert.equal(buildPayloadHash(input), buildPayloadHash({ ...input }));
  assert.notEqual(buildPayloadHash(input), buildPayloadHash({ ...input, rkey: 'def' }));
});

test('maps null createdAt to canonical null payload fields', () => {
  const tuple = buildCanonicalPayloadTuple({
    collection: 'app.example.post',
    did: 'did:plc:example',
    rkey: 'abc',
    createdAt: null,
  });

  assert.equal(tuple.createdAtKey, '<NULL>');
  assert.equal(tuple.createdHourKey, '<NULL_HOUR>');
});

test('queue sequence generator is lexicographic and non-empty', () => {
  const generator = new QueueSequenceGenerator({
    writerId: 'sync/writer',
    randomSuffix: () => 'suffix',
  });

  const first = generator.next(new Date('2026-05-10T00:00:00.001Z'));
  const second = generator.next(new Date('2026-05-10T00:00:00.001Z'));
  const third = generator.next(new Date('2026-05-10T00:00:00.000Z'));

  assert.match(first, /^1778371200001-sync_writer-00000000-suffix$/);
  assert(first < second);
  assert(second < third);
  assert.equal(assertNonEmptyQueueSeq(first), first);
  assert.throws(() => assertNonEmptyQueueSeq(''), /queue_seq/);
  assert.throws(() => assertNonEmptyQueueSeq(null), /queue_seq/);
});

test('compares queue cursors by queued_at, event_key, queue_seq', () => {
  const base = {
    queuedAt: '2026-05-10 00:00:00.000',
    eventKey: 'event-a',
    queueSeq: '0001',
  };

  assert.equal(compareQueueCursor(base, { ...base }), 0);
  assert.equal(compareQueueCursor({ ...base, queueSeq: '0002' }, base), 1);
  assert.equal(compareQueueCursor({ ...base, eventKey: 'event-b', queueSeq: '0000' }, base), 1);
  assert.equal(compareQueueCursor({ ...base, queuedAt: '2026-05-10 00:00:00.001', eventKey: 'event-0' }, base), 1);
  assert.equal(isQueueCursorAfter({ ...base, queueSeq: '0002' }, base), true);
  assert.equal(isQueueCursorAfter(base, { ...base, queueSeq: '0002' }), false);
});

test('bumps queued_at beyond latest and active cutoffs', () => {
  const cursor = {
    queuedAt: '2026-05-10 00:00:00.000',
    eventKey: 'event-a',
    queueSeq: '0001',
  };

  const bumped = ensureQueueCursorAfterCutoffs(cursor, [
    {
      queuedAt: '2026-05-10 00:00:00.000',
      eventKey: 'event-a',
      queueSeq: '0001',
    },
    {
      queuedAt: '2026-05-10 00:00:00.001',
      eventKey: 'event-z',
      queueSeq: '9999',
    },
  ]);

  assert.deepEqual(bumped, {
    queuedAt: '2026-05-10 00:00:00.002',
    eventKey: 'event-a',
    queueSeq: '0001',
  });
});

test('queue cursor predicate uses compound watermark and not source_ingested_at', () => {
  const predicate = buildQueueCursorPredicate('q');

  assert.match(predicate, /\(q\.queued_at, q\.event_key, q\.queue_seq\) >/);
  assert.match(predicate, /\(q\.queued_at, q\.event_key, q\.queue_seq\) <=/);
  assert.doesNotMatch(predicate, /source_ingested_at/);
});

test('shared lock path is stable', () => {
  assert.equal(COLLECTION_COUNT_INCREMENTAL_LOCK_PATH, '/run/atpdashboard-collection-count-incremental.lock');
});
