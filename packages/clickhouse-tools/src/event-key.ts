const NULL_CREATED_AT_KEY = '<NULL>';

export type CollectionEventKeyInput = {
  did: string;
  collection: string;
  rkey: string;
  createdAt: string | Date | null | undefined;
};

export type NormalizedCollectionEventKey = {
  eventKey: string;
  createdAtKey: string;
};

export function normalizeCreatedAtKey(createdAt: string | Date | null | undefined): string {
  if (createdAt == null || createdAt === '') {
    return NULL_CREATED_AT_KEY;
  }

  if (createdAt instanceof Date) {
    if (Number.isNaN(createdAt.getTime())) {
      throw new Error(`Invalid createdAt: ${String(createdAt)}`);
    }

    const iso = createdAt.toISOString();
    return `${iso.slice(0, -1)}000Z`;
  }

  const text = createdAt.trim();
  const match = text.match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6})\d*)?(Z|[+-]\d{2}:?\d{2})?$/,
  );

  if (!match) {
    throw new Error(`Invalid createdAt: ${String(createdAt)}`);
  }

  const [, datePart, timePart, fractional = '', timezone = 'Z'] = match;
  const normalizedTimezone = timezone === 'Z' ? 'Z' : `${timezone.slice(0, 3)}:${timezone.slice(-2)}`;
  const utcSecond = new Date(`${datePart}T${timePart}${normalizedTimezone}`);

  if (Number.isNaN(utcSecond.getTime())) {
    throw new Error(`Invalid createdAt: ${String(createdAt)}`);
  }

  const microseconds = fractional.padEnd(6, '0').slice(0, 6);
  return `${utcSecond.toISOString().slice(0, 19)}.${microseconds}Z`;
}

export function buildLengthPrefixedPart(value: string): string {
  const byteLength = new TextEncoder().encode(value).length;
  return `${byteLength}:${value}`;
}

export function buildCollectionEventKey(input: CollectionEventKeyInput): NormalizedCollectionEventKey {
  const createdAtKey = normalizeCreatedAtKey(input.createdAt);
  const parts = [input.did, input.collection, input.rkey, createdAtKey].map(buildLengthPrefixedPart);

  return {
    eventKey: parts.join(''),
    createdAtKey,
  };
}
