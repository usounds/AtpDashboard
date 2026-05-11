import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const script = readFileSync(resolve(import.meta.dirname, '../../../scripts/publish_collection_count_baseline_from_queue.sh'), 'utf8');

test('baseline publisher filters lexicon store before event_key aggregation', () => {
  assert.match(script, /FROM\s*\(\s*SELECT \*\s*FROM collection_count_ingest_queue\s*WHERE did != 'did:web:lexicon\.store'\s*\) AS q\s*GROUP BY q\.event_key/s);
  assert.doesNotMatch(script, /FROM collection_count_ingest_queue\s+WHERE .*did != 'did:web:lexicon\.store'\s+GROUP BY event_key/s);
});

test('baseline publisher qualifies aggregate inputs in event stage insert', () => {
  assert.match(script, /any\(q\.did\) AS did/);
  assert.match(script, /any\(q\.collection\) AS collection/);
  assert.match(script, /any\(q\.rkey\) AS rkey/);
  assert.match(script, /min\(q\.queued_at\) AS queued_at/);
  assert.match(script, /argMin\(q\.queue_seq, tuple\(q\.queued_at, q\.queue_seq, q\.payload_hash\)\) AS queue_seq/);
  assert.doesNotMatch(script, /argMin\(queue_seq, tuple\(queued_at, queue_seq, payload_hash\)\) AS queue_seq/);
});
