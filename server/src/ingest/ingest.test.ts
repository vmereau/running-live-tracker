import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IngestAck, MAX_BATCH_RECORDS } from '@running-live-tracker/shared';
import type { IngestBatch } from '@running-live-tracker/shared';
import { createKeyLookup } from '../config/key-lookup.ts';
import type { EventConfig } from '../config/load-config.ts';
import type { RecordsCommitted } from '../projection/create-projection.ts';
import { openStore } from '../store/open-store.ts';
import type { Store } from '../store/open-store.ts';
import { createIngest } from './ingest.ts';
import type { IngestAccepted, IngestRejection, IngestResult } from './ingest.ts';

const fixturesDir = join(import.meta.dirname, '..', '..', '..', 'shared', 'fixtures');
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'));
const mixed = () => fixture('valid/ingest-batch.mixed.json') as IngestBatch;

// ingest may not import domain; this mirrors hashKey (SHA-256, lowercase hex) for the test config.
const sha256 = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex');
const aliceKey = 'iPjrsCiGy9NtfNOBsf18EVex9bcFh_IiBKe7NCeXNuc';
const bobKey = 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5';
const config: EventConfig = {
  eventId: 'test-run',
  name: 'Test run',
  opensAt: 1,
  closesAt: 2,
  runners: [
    { runnerId: 'alice', displayName: 'Alice', color: '#e6194b', keyHash: sha256(aliceKey) },
    { runnerId: 'bob', displayName: 'Bob', color: '#3cb44b', keyHash: sha256(bobKey) },
  ],
};

const NOW = 1_760_000_060_000;

/** Records every recordsCommitted call, with how many rows the store held for that session at that moment. */
function spyProjection(store: () => Store) {
  const calls: (RecordsCommitted & { storedRows: number })[] = [];
  return {
    calls,
    projection: {
      recordsCommitted: (c: RecordsCommitted) => void calls.push({ ...c, storedRows: store().readRecords(c.sessionId).length }),
    },
  };
}

function setup() {
  const store = openStore(':memory:');
  let now = NOW;
  const spy = spyProjection(() => store);
  const ingest = createIngest({ store, findRunner: createKeyLookup(config), projection: spy.projection, now: () => now });
  return { store, ingest, tick: () => (now += 1_000), committed: spy.calls };
}

const noProjection = { recordsCommitted: () => {} };

function accepted(result: IngestResult): IngestAccepted {
  assert.ok(result.ok, `expected acceptance, got ${JSON.stringify(result)}`);
  IngestAck.parse(result.ack);
  return result;
}

function rejected(result: IngestResult, status: number, code: string): IngestRejection {
  assert.ok(!result.ok, 'expected a rejection');
  assert.equal(result.status, status);
  assert.equal(result.code, code);
  return result;
}

function rowCount(store: Store, sessionId: string): number {
  return store.readRecords(sessionId).length;
}

test('authenticate accepts only a Bearer header holding a configured key', () => {
  const { ingest, store } = setup();
  try {
    assert.equal(ingest.authenticate(`Bearer ${aliceKey}`), 'alice');
    assert.equal(ingest.authenticate(`bearer ${bobKey}`), 'bob');
    for (const header of [
      undefined,
      '',
      'Bearer',
      'Bearer ',
      aliceKey,
      `Basic ${aliceKey}`,
      `Bearer ${aliceKey}x`,
      `Bearer ${aliceKey} extra`,
      `Bearer ${sha256(aliceKey)}`,
    ]) {
      assert.equal(ingest.authenticate(header), undefined, String(header));
    }
  } finally {
    store.close();
  }
});

test('first batch stores the session under the key runner and acks the last seq', () => {
  const { ingest, store } = setup();
  try {
    const batch = mixed();
    const result = accepted(ingest.ingestBatch('alice', batch));
    assert.deepStrictEqual(result.ack, { sessionId: batch.sessionId, ackedThroughSeq: 3, serverNow: NOW });
    assert.equal(result.recordCount, 3);
    assert.equal(result.inserted, 3);
    assert.equal(result.clockSkewMs, NOW - 1_760_000_010_000);
    assert.deepStrictEqual(store.readSession(batch.sessionId), {
      sessionId: batch.sessionId,
      runnerId: 'alice',
      sessionStartedAt: batch.sessionStartedAt,
      firstReceivedAt: NOW,
    });
    const rows = store.readRecords(batch.sessionId);
    assert.deepStrictEqual(rows.map((r) => [r.seq, r.kind, r.receivedAt]), [
      [0, 'fix', NOW],
      [1, 'fix', NOW],
      [3, 'end', NOW],
    ]);
  } finally {
    store.close();
  }
});

test('resending the same batch gives the same ack with a fresh serverNow and stores nothing new', () => {
  const { ingest, store, tick } = setup();
  try {
    const first = accepted(ingest.ingestBatch('alice', mixed()));
    tick();
    const second = accepted(ingest.ingestBatch('alice', mixed()));
    assert.equal(second.ack.ackedThroughSeq, first.ack.ackedThroughSeq);
    assert.equal(second.ack.serverNow, NOW + 1_000);
    assert.equal(second.inserted, 0);
    assert.equal(rowCount(store, mixed().sessionId), 3);
    assert.equal(store.readSession(mixed().sessionId)?.firstReceivedAt, NOW);
  } finally {
    store.close();
  }
});

test('an overlapping batch stores only the new seqs and acks its own last seq', () => {
  const { ingest, store, tick } = setup();
  try {
    accepted(ingest.ingestBatch('alice', mixed()));
    tick();
    const next = {
      ...mixed(),
      records: [
        { seq: 1, kind: 'fix', recordedAt: 1, lat: 10, lon: 10, accuracyM: 1 },
        // The largest recordedAt is in the middle: skew uses the max, not the last record.
        { seq: 4, kind: 'fix', recordedAt: 1_760_000_025_000, lat: 48.857, lon: 2.353, accuracyM: 6 },
        { seq: 5, kind: 'end', recordedAt: 1_760_000_020_000 },
      ],
    };
    const result = accepted(ingest.ingestBatch('alice', next));
    assert.equal(result.ack.ackedThroughSeq, 5);
    assert.equal(result.inserted, 2);
    assert.equal(result.clockSkewMs, NOW + 1_000 - 1_760_000_025_000);
    const rows = store.readRecords(mixed().sessionId);
    assert.deepStrictEqual(rows.map((r) => [r.seq, r.receivedAt]), [
      [0, NOW],
      [1, NOW],
      [3, NOW],
      [4, NOW + 1_000],
      [5, NOW + 1_000],
    ]);
    assert.equal(rows[1]!.lat, 48.8567, 'the repeated seq keeps its first stored value');
  } finally {
    store.close();
  }
});

test('a runnerId in the body is ignored: the key decides', () => {
  const { ingest, store } = setup();
  try {
    accepted(ingest.ingestBatch('alice', { ...mixed(), runnerId: 'bob' }));
    assert.equal(store.sessionOwner(mixed().sessionId), 'alice');
  } finally {
    store.close();
  }
});

const invalidBodies: [string, unknown][] = [
  ['null', null],
  ['a string', 'not json'],
  ['an array', [mixed()]],
  ['a number', 42],
  ['records missing', { sessionId: mixed().sessionId, sessionStartedAt: 1 }],
  ['records not an array', { ...mixed(), records: 'x' }],
  ['lat 91', { ...mixed(), records: [fixture('invalid/fix-record.lat-91.json')] }],
  ['optional null', { ...mixed(), records: [fixture('invalid/fix-record.optional-null.json')] }],
  ...readdirSync(join(fixturesDir, 'invalid'))
    .filter((f) => f.startsWith('ingest-batch.'))
    .map((f): [string, unknown] => [f, fixture(`invalid/${f}`)]),
];

for (const [name, body] of invalidBodies) {
  test(`bad body (${name}) is 400 INVALID_BATCH and stores nothing`, () => {
    const { ingest, store } = setup();
    try {
      rejected(ingest.ingestBatch('alice', body), 400, 'INVALID_BATCH');
      assert.equal(store.sessionOwner(mixed().sessionId), undefined);
      assert.equal(rowCount(store, mixed().sessionId), 0);
    } finally {
      store.close();
    }
  });
}

test('the rejection message names the failing field without echoing values', () => {
  const { ingest, store } = setup();
  try {
    const body = { ...mixed(), records: [{ seq: 0, kind: 'fix', recordedAt: 1, lat: 91.123456, lon: 2.3522, accuracyM: 4.5 }] };
    const result = rejected(ingest.ingestBatch('alice', body), 400, 'INVALID_BATCH');
    assert.match(result.message, /records\.0\.lat/);
    assert.ok(!result.message.includes('91.123456'));
  } finally {
    store.close();
  }
});

function recordsOf(count: number) {
  return Array.from({ length: count }, (_, seq) => ({ seq, kind: 'fix', recordedAt: 1_760_000_000_000 + seq, lat: 1, lon: 1, accuracyM: 5 }));
}

test(`${MAX_BATCH_RECORDS + 1} records is 413 BATCH_TOO_LARGE and stores nothing`, () => {
  const { ingest, store } = setup();
  try {
    rejected(ingest.ingestBatch('alice', { ...mixed(), records: recordsOf(MAX_BATCH_RECORDS + 1) }), 413, 'BATCH_TOO_LARGE');
    // Size is checked before the schema: an oversized batch of junk is still 413.
    rejected(ingest.ingestBatch('alice', { records: new Array(MAX_BATCH_RECORDS + 1).fill(0) }), 413, 'BATCH_TOO_LARGE');
    assert.equal(rowCount(store, mixed().sessionId), 0);
    assert.equal(store.sessionOwner(mixed().sessionId), undefined);
  } finally {
    store.close();
  }
});

test(`exactly ${MAX_BATCH_RECORDS} records is accepted`, () => {
  const { ingest, store } = setup();
  try {
    const result = accepted(ingest.ingestBatch('alice', { ...mixed(), records: recordsOf(MAX_BATCH_RECORDS) }));
    assert.equal(result.ack.ackedThroughSeq, MAX_BATCH_RECORDS - 1);
    assert.equal(rowCount(store, mixed().sessionId), MAX_BATCH_RECORDS);
  } finally {
    store.close();
  }
});

test("bob posting to alice's session is 409 SESSION_OWNER_MISMATCH and stores nothing", () => {
  const { ingest, store } = setup();
  try {
    const first = { ...mixed(), records: mixed().records.slice(0, 1) };
    accepted(ingest.ingestBatch('alice', first));
    rejected(ingest.ingestBatch('bob', mixed()), 409, 'SESSION_OWNER_MISMATCH');
    assert.equal(store.sessionOwner(mixed().sessionId), 'alice');
    assert.equal(rowCount(store, mixed().sessionId), 1);
  } finally {
    store.close();
  }
});

test('restart: a reopened file store keeps the rows and the session owner', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'rlt-ingest-')), 'tracker.db');
  const findRunner = createKeyLookup(config);

  const store1 = openStore(path);
  accepted(createIngest({ store: store1, findRunner, projection: noProjection, now: () => NOW }).ingestBatch('alice', mixed()));
  store1.close();

  const store2 = openStore(path);
  try {
    const ingest = createIngest({ store: store2, findRunner, projection: noProjection, now: () => NOW + 5 });
    assert.equal(rowCount(store2, mixed().sessionId), 3);
    assert.equal(accepted(ingest.ingestBatch('alice', mixed())).inserted, 0);
    rejected(ingest.ingestBatch('bob', mixed()), 409, 'SESSION_OWNER_MISMATCH');
  } finally {
    store2.close();
  }
});

// ---- Story 1.5: projection notification ----

test('every accepted batch notifies the projection after commit, duplicates included', () => {
  const { ingest, store, committed } = setup();
  try {
    accepted(ingest.ingestBatch('alice', mixed()));
    accepted(ingest.ingestBatch('alice', mixed()));
    const next = { ...mixed(), records: [{ seq: 1, kind: 'fix', recordedAt: 1, lat: 1, lon: 1, accuracyM: 1 }, { seq: 4, kind: 'end', recordedAt: 2 }] };
    accepted(ingest.ingestBatch('alice', next));
    const sessionId = mixed().sessionId;
    assert.deepStrictEqual(committed, [
      { runnerId: 'alice', sessionId, firstInsertedSeq: 0, storedRows: 3 },
      { runnerId: 'alice', sessionId, firstInsertedSeq: null, storedRows: 3 },
      { runnerId: 'alice', sessionId, firstInsertedSeq: 4, storedRows: 4 },
    ]);
  } finally {
    store.close();
  }
});

test('rejected batches (400, 409, 413) never notify the projection', () => {
  const { ingest, store, committed } = setup();
  try {
    rejected(ingest.ingestBatch('alice', null), 400, 'INVALID_BATCH');
    rejected(ingest.ingestBatch('alice', { ...mixed(), records: recordsOf(MAX_BATCH_RECORDS + 1) }), 413, 'BATCH_TOO_LARGE');
    accepted(ingest.ingestBatch('alice', { ...mixed(), records: mixed().records.slice(0, 1) }));
    committed.length = 0;
    rejected(ingest.ingestBatch('bob', mixed()), 409, 'SESSION_OWNER_MISMATCH');
    assert.deepStrictEqual(committed, []);
  } finally {
    store.close();
  }
});

test('a projection failure surfaces as a throw after the batch is stored', () => {
  const store = openStore(':memory:');
  try {
    const projection = {
      recordsCommitted: () => {
        throw new Error('projection broke');
      },
    };
    const ingest = createIngest({ store, findRunner: createKeyLookup(config), projection, now: () => NOW });
    assert.throws(() => ingest.ingestBatch('alice', mixed()), /projection broke/);
    assert.equal(rowCount(store, mixed().sessionId), 3, 'the commit is kept; the phone resends and the projection heals');
  } finally {
    store.close();
  }
});
