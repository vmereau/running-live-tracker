import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { IngestRecord } from '@running-live-tracker/shared';
import { openStore, SessionOwnerMismatchError } from './open-store.ts';

const sessionId = '3f1c2b9e-8a4d-4c6e-9b2a-1d5e7f0a3c48';
const records: IngestRecord[] = [
  { seq: 0, kind: 'fix', recordedAt: 1000, lat: 48.8566, lon: 2.3522, accuracyM: 4.5, altitudeM: 35.2, speedMps: 3.1 },
  { seq: 1, kind: 'fix', recordedAt: 2000, lat: 48.8567, lon: 2.3524, accuracyM: 5 },
  { seq: 3, kind: 'end', recordedAt: 3000 },
];
const batch = { runnerId: 'alice', sessionId, sessionStartedAt: 900, receivedAt: 5000, records };

test('appendBatch stores the session once and records with NULL for absent fields', () => {
  const store = openStore(':memory:');
  try {
    assert.equal(store.sessionOwner(sessionId), undefined);
    assert.deepStrictEqual(store.appendBatch(batch), { inserted: 3, firstInsertedSeq: 0 });
    assert.equal(store.sessionOwner(sessionId), 'alice');
    assert.deepStrictEqual(store.readSession(sessionId), {
      sessionId,
      runnerId: 'alice',
      sessionStartedAt: 900,
      firstReceivedAt: 5000,
    });
    const rows = store.readRecords(sessionId);
    assert.deepStrictEqual(rows.map((r) => r.seq), [0, 1, 3]);
    assert.deepStrictEqual(rows[0], {
      sessionId, seq: 0, kind: 'fix', recordedAt: 1000, receivedAt: 5000,
      lat: 48.8566, lon: 2.3522, accuracyM: 4.5, altitudeM: 35.2, speedMps: 3.1,
    });
    assert.deepStrictEqual(rows[1], {
      sessionId, seq: 1, kind: 'fix', recordedAt: 2000, receivedAt: 5000,
      lat: 48.8567, lon: 2.3524, accuracyM: 5, altitudeM: null, speedMps: null,
    });
    assert.deepStrictEqual(rows[2], {
      sessionId, seq: 3, kind: 'end', recordedAt: 3000, receivedAt: 5000,
      lat: null, lon: null, accuracyM: null, altitudeM: null, speedMps: null,
    });
  } finally {
    store.close();
  }
});

test('appendBatch ignores repeated seqs and never updates the session row', () => {
  const store = openStore(':memory:');
  try {
    store.appendBatch(batch);
    assert.deepStrictEqual(store.appendBatch({ ...batch, receivedAt: 9000, sessionStartedAt: 1 }), { inserted: 0, firstInsertedSeq: null });
    const overlap: IngestRecord[] = [
      { seq: 3, kind: 'end', recordedAt: 7777 },
      { seq: 4, kind: 'fix', recordedAt: 4000, lat: 1, lon: 2, accuracyM: 3 },
    ];
    assert.deepStrictEqual(store.appendBatch({ ...batch, receivedAt: 9000, records: overlap }), { inserted: 1, firstInsertedSeq: 4 });
    assert.equal(store.readSession(sessionId)?.firstReceivedAt, 5000);
    assert.equal(store.readSession(sessionId)?.sessionStartedAt, 900);
    const rows = store.readRecords(sessionId);
    assert.deepStrictEqual(rows.map((r) => [r.seq, r.recordedAt, r.receivedAt]), [
      [0, 1000, 5000],
      [1, 2000, 5000],
      [3, 3000, 5000],
      [4, 4000, 9000],
    ]);
  } finally {
    store.close();
  }
});

test("appendBatch for another runner's session throws and stores nothing", () => {
  const store = openStore(':memory:');
  try {
    store.appendBatch({ ...batch, records: records.slice(0, 1) });
    assert.throws(() => store.appendBatch({ ...batch, runnerId: 'bob' }), SessionOwnerMismatchError);
    assert.equal(store.readRecords(sessionId).length, 1);
    assert.equal(store.sessionOwner(sessionId), 'alice');
  } finally {
    store.close();
  }
});

test('a failing record rolls back the whole batch, session row included', () => {
  const store = openStore(':memory:');
  try {
    const bad = [records[0]!, { seq: 1, kind: 'bogus', recordedAt: 1 } as unknown as IngestRecord];
    assert.throws(() => store.appendBatch({ ...batch, records: bad }));
    assert.equal(store.sessionOwner(sessionId), undefined);
    assert.equal(store.readRecords(sessionId).length, 0);
  } finally {
    store.close();
  }
});

test('a file store uses WAL and keeps its rows across close and reopen', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'rlt-store-')), 'tracker.db');
  const first = openStore(path);
  first.appendBatch(batch);
  first.close();

  const raw = new Database(path, { readonly: true });
  try {
    assert.equal(raw.pragma('journal_mode', { simple: true }), 'wal');
  } finally {
    raw.close();
  }

  const second = openStore(path);
  try {
    assert.equal(second.sessionOwner(sessionId), 'alice');
    assert.equal(second.readSession(sessionId)?.firstReceivedAt, 5000);
    assert.equal(second.readRecords(sessionId).length, 3);
    assert.deepStrictEqual(second.appendBatch(batch), { inserted: 0, firstInsertedSeq: null });
  } finally {
    second.close();
  }
});

test('readRunRecords joins the stored sessionStartedAt, filters runner and window, orders canonically', () => {
  const store = openStore(':memory:');
  try {
    const fix = (seq: number): IngestRecord => ({ seq, kind: 'fix', recordedAt: 10_000 + seq, lat: 1, lon: 2, accuracyM: 3 });
    const sA = '00000000-0000-4000-8000-00000000000a';
    const sB = '00000000-0000-4000-8000-00000000000b';
    const sC = '00000000-0000-4000-8000-00000000000c';
    // sB starts first; sA and sC share a start, so sessionId breaks the tie.
    store.appendBatch({ runnerId: 'alice', sessionId: sA, sessionStartedAt: 200, receivedAt: 1, records: [fix(2), fix(5)] });
    store.appendBatch({ runnerId: 'alice', sessionId: sC, sessionStartedAt: 200, receivedAt: 1, records: [fix(0)] });
    store.appendBatch({ runnerId: 'alice', sessionId: sB, sessionStartedAt: 100, receivedAt: 1, records: [fix(7)] });
    // A later batch claiming another start does not move the session: the first written start is canonical.
    store.appendBatch({ runnerId: 'alice', sessionId: sA, sessionStartedAt: 50, receivedAt: 1, records: [fix(3)] });
    // Other runner, and sessions outside the window.
    store.appendBatch({ runnerId: 'bob', sessionId, sessionStartedAt: 150, receivedAt: 1, records: [fix(0)] });
    store.appendBatch({ runnerId: 'alice', sessionId: '00000000-0000-4000-8000-0000000000d0', sessionStartedAt: 99, receivedAt: 1, records: [fix(0)] });
    store.appendBatch({ runnerId: 'alice', sessionId: '00000000-0000-4000-8000-0000000000e0', sessionStartedAt: 201, receivedAt: 1, records: [fix(0)] });

    const keys = (rows: { sessionStartedAt: number; sessionId: string; seq: number }[]) =>
      rows.map((r) => [r.sessionStartedAt, r.sessionId, r.seq]);
    const all = store.readRunRecords('alice', 100, 200);
    assert.deepStrictEqual(keys(all), [
      [100, sB, 7],
      [200, sA, 2],
      [200, sA, 3],
      [200, sA, 5],
      [200, sC, 0],
    ]);
    assert.deepStrictEqual(all[0], {
      sessionStartedAt: 100, sessionId: sB, seq: 7, kind: 'fix', recordedAt: 10_007, receivedAt: 1,
      lat: 1, lon: 2, accuracyM: 3, altitudeM: null, speedMps: null,
    });
    assert.deepStrictEqual(keys(store.readRunRecords('alice', 100, 200, { sessionStartedAt: 200, sessionId: sA, seq: 2 })), [
      [200, sA, 3],
      [200, sA, 5],
      [200, sC, 0],
    ]);
    assert.deepStrictEqual(keys(store.readRunRecords('alice', 100, 200, { sessionStartedAt: 200, sessionId: sC, seq: 0 })), []);
    assert.deepStrictEqual(keys(store.readRunRecords('alice', 100, 200, { sessionStartedAt: 0, sessionId: '', seq: 0 })), keys(all));
    assert.deepStrictEqual(keys(store.readRunRecords('bob', 100, 200)), [[150, sessionId, 0]]);
    assert.deepStrictEqual(store.readRunRecords('carol', 0, 1_000), []);
  } finally {
    store.close();
  }
});
