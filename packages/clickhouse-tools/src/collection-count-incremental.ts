import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { normalizeCreatedAtKey } from './event-key.ts';

export const COLLECTION_COUNT_INCREMENTAL_LOCK_PATH = '/run/atpdashboard-collection-count-incremental.lock';
export const NULL_HOUR_KEY = '<NULL_HOUR>';

export type QueueCursor = {
  queuedAt: string;
  eventKey: string;
  queueSeq: string;
};

export type CanonicalPayloadInput = {
  collection: string;
  did: string;
  rkey: string;
  createdAt: string | Date | null | undefined;
};

export type CanonicalPayloadTuple = {
  collection: string;
  did: string;
  rkey: string;
  createdAtKey: string;
  createdHourKey: string;
};

export type QueueSequenceGeneratorOptions = {
  writerId?: string;
  randomSuffix?: () => string;
};

export function buildCanonicalPayloadTuple(input: CanonicalPayloadInput): CanonicalPayloadTuple {
  const createdAtKey = normalizeCreatedAtKey(input.createdAt);

  return {
    collection: input.collection,
    did: input.did,
    rkey: input.rkey,
    createdAtKey,
    createdHourKey: createdAtKey === '<NULL>' ? NULL_HOUR_KEY : `${createdAtKey.slice(0, 13)}:00:00Z`,
  };
}

export function buildPayloadHash(input: CanonicalPayloadInput | CanonicalPayloadTuple): string {
  const tuple = 'createdAtKey' in input ? input : buildCanonicalPayloadTuple(input);
  const payload = [tuple.collection, tuple.did, tuple.rkey, tuple.createdAtKey, tuple.createdHourKey]
    .map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`)
    .join('\0');
  const digest = createHash('sha256').update(payload).digest();

  return digest.readBigUInt64BE(0).toString();
}

export class QueueSequenceGenerator {
  private readonly writerId: string;
  private readonly randomSuffix: () => string;
  private lastMs = -1;
  private counter = 0;

  constructor(options: QueueSequenceGeneratorOptions = {}) {
    this.writerId = sanitizeQueueSeqPart(options.writerId ?? randomUUID());
    this.randomSuffix = options.randomSuffix ?? (() => randomBytes(4).toString('hex'));
  }

  next(now: Date | number = Date.now()): string {
    const ms = now instanceof Date ? now.getTime() : now;
    if (!Number.isFinite(ms)) {
      throw new Error(`Invalid queue sequence time: ${String(now)}`);
    }

    const currentMs = Math.trunc(ms);
    if (currentMs > this.lastMs) {
      this.lastMs = currentMs;
      this.counter = 0;
    } else {
      this.counter += 1;
    }

    return [
      String(this.lastMs).padStart(13, '0'),
      this.writerId,
      String(this.counter).padStart(8, '0'),
      sanitizeQueueSeqPart(this.randomSuffix()),
    ].join('-');
  }
}

export function assertNonEmptyQueueSeq(queueSeq: string | null | undefined): string {
  if (queueSeq == null || queueSeq.trim() === '') {
    throw new Error('queue_seq must be non-empty');
  }
  return queueSeq;
}

export function compareQueueCursor(left: QueueCursor, right: QueueCursor): number {
  const leftQueueSeq = assertNonEmptyQueueSeq(left.queueSeq);
  const rightQueueSeq = assertNonEmptyQueueSeq(right.queueSeq);
  return compareTuple(
    [normalizeQueuedAt(left.queuedAt), left.eventKey, leftQueueSeq],
    [normalizeQueuedAt(right.queuedAt), right.eventKey, rightQueueSeq],
  );
}

export function isQueueCursorAfter(cursor: QueueCursor, cutoff: QueueCursor | null | undefined): boolean {
  return cutoff == null || compareQueueCursor(cursor, cutoff) > 0;
}

export function ensureQueueCursorAfterCutoffs(
  cursor: QueueCursor,
  cutoffs: Array<QueueCursor | null | undefined>,
): QueueCursor {
  let nextCursor = { ...cursor, queueSeq: assertNonEmptyQueueSeq(cursor.queueSeq), queuedAt: normalizeQueuedAt(cursor.queuedAt) };

  for (const cutoff of cutoffs) {
    if (cutoff != null && compareQueueCursor(nextCursor, cutoff) <= 0) {
      nextCursor = {
        ...nextCursor,
        queuedAt: addMilliseconds(normalizeQueuedAt(cutoff.queuedAt), 1),
      };
    }
  }

  return nextCursor;
}

export function buildQueueCursorPredicate(alias = ''): string {
  const prefix = alias === '' ? '' : `${alias}.`;
  return `(${prefix}queued_at, ${prefix}event_key, ${prefix}queue_seq) > ({watermark_queued_at:DateTime64(3, 'UTC')}, {watermark_event_key:String}, {watermark_queue_seq:String})
  AND (${prefix}queued_at, ${prefix}event_key, ${prefix}queue_seq) <= ({cutoff_queued_at:DateTime64(3, 'UTC')}, {cutoff_event_key:String}, {cutoff_queue_seq:String})`;
}

function normalizeQueuedAt(value: string): string {
  const text = value.trim();
  const iso = text.includes('T') ? text : `${text.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid queued_at: ${value}`);
  }
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function addMilliseconds(value: string, milliseconds: number): string {
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  date.setUTCMilliseconds(date.getUTCMilliseconds() + milliseconds);
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function compareTuple(left: string[], right: string[]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function sanitizeQueueSeqPart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_:.]/g, '_');
  if (sanitized === '') {
    throw new Error('queue_seq part must be non-empty');
  }
  return sanitized;
}
