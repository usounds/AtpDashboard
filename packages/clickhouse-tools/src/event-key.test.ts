import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCollectionEventKey,
  buildLengthPrefixedPart,
  normalizeCreatedAtKey,
} from './event-key.ts';

test('normalizes null createdAt to sentinel', () => {
  assert.equal(normalizeCreatedAtKey(null), '<NULL>');
  assert.equal(normalizeCreatedAtKey(undefined), '<NULL>');
  assert.equal(normalizeCreatedAtKey(''), '<NULL>');
});

test('normalizes createdAt to UTC microsecond string', () => {
  assert.equal(normalizeCreatedAtKey('2026-05-09T14:34:10.699+09:00'), '2026-05-09T05:34:10.699000Z');
  assert.equal(normalizeCreatedAtKey('2026-05-09T05:34:10.699Z'), '2026-05-09T05:34:10.699000Z');
});

test('rejects invalid createdAt', () => {
  assert.throws(() => normalizeCreatedAtKey('not-a-date'), /Invalid createdAt/);
});

test('uses byte length prefix for delimiter and unicode safety', () => {
  assert.equal(buildLengthPrefixedPart('a:b'), '3:a:b');
  assert.equal(buildLengthPrefixedPart('あ'), '3:あ');
});

test('builds stable deterministic event key', () => {
  const input = {
    did: 'did:plc:example',
    collection: 'app.example.post',
    rkey: 'abc:123',
    createdAt: '2026-05-09T14:34:10.699+09:00',
  };

  const first = buildCollectionEventKey(input);
  const second = buildCollectionEventKey({ ...input });

  assert.deepEqual(first, second);
  assert.equal(first.createdAtKey, '2026-05-09T05:34:10.699000Z');
  assert.equal(
    first.eventKey,
    '15:did:plc:example16:app.example.post7:abc:12327:2026-05-09T05:34:10.699000Z',
  );
});

test('different createdAt values produce different keys for same did collection rkey', () => {
  const base = {
    did: 'did:plc:example',
    collection: 'app.example.post',
    rkey: 'abc',
  };

  const first = buildCollectionEventKey({ ...base, createdAt: '2026-05-09T05:34:10.699Z' });
  const second = buildCollectionEventKey({ ...base, createdAt: '2026-05-09T05:34:10.700Z' });

  assert.notEqual(first.eventKey, second.eventKey);
});

