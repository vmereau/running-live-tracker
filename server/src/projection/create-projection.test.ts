import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Snapshot } from '@running-live-tracker/shared';
import type { IngestRecord } from '@running-live-tracker/shared';
import type { EventConfig } from '../config/load-config.ts';
import { buildCourse } from '../domain/course.ts';
import { openStore } from '../store/open-store.ts';
import type { Store } from '../store/open-store.ts';
import { createProjection } from './create-projection.ts';
import type { Projection, RunnerChange } from './create-projection.ts';
import { initialRunnerView } from './snapshot.ts';

const config: EventConfig = {
  eventId: 'test-run',
  name: 'Test run',
  opensAt: 10_000,
  closesAt: 1_000_000,
  runners: [
    { runnerId: 'alice', displayName: 'Alice', color: '#e6194b', keyHash: 'a'.repeat(64) },
    { runnerId: 'bob', displayName: 'Bob', color: '#3cb44b', keyHash: 'b'.repeat(64) },
  ],
};

const S1 = '00000000-0000-4000-8000-000000000001';
const S2 = '00000000-0000-4000-8000-000000000002';
const S3 = '00000000-0000-4000-8000-000000000003';

const fix = (seq: number, recordedAt: number, accuracyM = 5): IngestRecord => ({
  seq,
  kind: 'fix',
  recordedAt,
  lat: 48 + seq / 1000,
  lon: 2 + recordedAt / 1e7,
  accuracyM,
});
const end = (seq: number, recordedAt: number): IngestRecord => ({ seq, kind: 'end', recordedAt });

type Batch = { runnerId: string; sessionId: string; sessionStartedAt: number; records: IngestRecord[] };

/** What ingest does: one committed batch, then recordsCommitted. */
function commit(store: Store, projection: Projection, batch: Batch, receivedAt: number): void {
  const { firstInsertedSeq } = store.appendBatch({ ...batch, receivedAt });
  projection.recordsCommitted({ runnerId: batch.runnerId, sessionId: batch.sessionId, firstInsertedSeq });
}

function setup(path = ':memory:') {
  const store = openStore(path);
  const projection = createProjection({ config, store });
  const changes: RunnerChange[] = [];
  projection.onChange((c) => changes.push(c));
  return { store, projection, changes };
}

const replaySnapshot = (store: Store) => createProjection({ config, store }).snapshot(0);

test('an empty store projects every runner notStarted with an empty track', () => {
  const { store, projection } = setup();
  try {
    const snap = Snapshot.parse(projection.snapshot(5));
    assert.equal(snap.serverNow, 5);
    assert.deepStrictEqual(snap.runners, [initialRunnerView('alice'), initialRunnerView('bob')]);
    assert.deepStrictEqual(snap.tracks, { alice: [], bob: [] });
  } finally {
    store.close();
  }
});

test('the course option fills hasCourse and lengthM in snapshots; without it there is no course', () => {
  const store = openStore(':memory:');
  try {
    const course = buildCourse([
      { lat: 48, lon: 2 },
      { lat: 48.01, lon: 2 },
    ]);
    const withCourse = createProjection({ config, store, course }).snapshot(0).event;
    assert.equal(withCourse.hasCourse, true);
    assert.equal(withCourse.lengthM, course.lengthM);
    const without = createProjection({ config, store }).snapshot(0).event;
    assert.equal(without.hasCourse, false);
    assert.equal(without.lengthM, null);
  } finally {
    store.close();
  }
});

test('first fix emits one change with the point; a poor fix emits the view only; a resend emits nothing', () => {
  const { store, projection, changes } = setup();
  try {
    const s1 = { runnerId: 'alice', sessionId: S1, sessionStartedAt: 20_000 };
    commit(store, projection, { ...s1, records: [fix(0, 21_000)] }, 21_500);
    assert.equal(changes.length, 1);
    const [first] = changes;
    assert.equal(first!.runnerId, 'alice');
    assert.equal(first!.trackReset, false);
    assert.deepStrictEqual(first!.appendedPoints, [{ lat: 48, lon: 2 + 21_000 / 1e7, recordedAt: 21_000 }]);
    assert.equal(first!.view.status, 'active');
    assert.equal(first!.view.runStartedAt, 21_000);
    assert.equal(first!.view.lastFixAt, 21_000);
    assert.equal(first!.view.lastReceivedAt, 21_500);

    commit(store, projection, { ...s1, records: [fix(1, 22_000, 30.1)] }, 22_500);
    assert.equal(changes.length, 2);
    assert.deepStrictEqual(changes[1]!.appendedPoints, []);
    assert.equal(changes[1]!.view.lastReceivedAt, 22_500);
    assert.equal(changes[1]!.view.lastFixAt, 21_000);

    commit(store, projection, { ...s1, records: [fix(0, 21_000), fix(1, 22_000, 30.1)] }, 30_000);
    assert.equal(changes.length, 2, 'duplicate resend: no emit');

    const snap = projection.snapshot(0);
    assert.deepStrictEqual(snap.runners[0], changes[1]!.view);
    assert.equal(snap.tracks['alice']!.length, 1);
    assert.deepStrictEqual(snap.runners[1], initialRunnerView('bob'));
  } finally {
    store.close();
  }
});

test('records after the end emit nothing and leave lastReceivedAt alone', () => {
  const { store, projection, changes } = setup();
  try {
    const s1 = { runnerId: 'alice', sessionId: S1, sessionStartedAt: 20_000 };
    commit(store, projection, { ...s1, records: [fix(0, 21_000), end(1, 22_000)] }, 22_500);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.view.status, 'stopped');
    assert.equal(changes[0]!.view.runEndedAt, 22_000);
    commit(store, projection, { ...s1, records: [fix(2, 23_000)] }, 23_500);
    assert.equal(changes.length, 1);
    assert.equal(projection.snapshot(0).runners[0]!.lastReceivedAt, 22_500);
  } finally {
    store.close();
  }
});

test('end in S1 then an accepted fix in S2: stopped, then active again with runEndedAt null', () => {
  const { store, projection, changes } = setup();
  try {
    commit(store, projection, { runnerId: 'alice', sessionId: S1, sessionStartedAt: 20_000, records: [fix(0, 21_000), end(1, 22_000)] }, 22_100);
    commit(store, projection, { runnerId: 'alice', sessionId: S2, sessionStartedAt: 30_000, records: [fix(0, 31_000)] }, 31_100);
    assert.deepStrictEqual(
      changes.map((c) => [c.view.status, c.view.runEndedAt, c.appendedPoints.length, c.trackReset]),
      [
        ['stopped', 22_000, 1, false],
        ['active', null, 1, false],
      ],
    );
  } finally {
    store.close();
  }
});

test('a session started outside the window is stored but never projected or emitted', () => {
  const { store, projection, changes } = setup();
  try {
    const before = projection.snapshot(0);
    commit(store, projection, { runnerId: 'alice', sessionId: S1, sessionStartedAt: 9_999, records: [fix(0, 21_000)] }, 21_100);
    commit(store, projection, { runnerId: 'bob', sessionId: S2, sessionStartedAt: 1_000_001, records: [fix(0, 1_000_100)] }, 1_000_200);
    assert.equal(store.readRecords(S1).length, 1);
    assert.deepStrictEqual(changes, []);
    assert.deepStrictEqual(projection.snapshot(0), before);
    // The bounds themselves are inside.
    commit(store, projection, { runnerId: 'alice', sessionId: S3, sessionStartedAt: 10_000, records: [fix(0, 21_000)] }, 21_100);
    assert.equal(changes.length, 1);
  } finally {
    store.close();
  }
});

test('a late older session refolds the runner, matches a replay and flags a track reset', () => {
  const { store, projection, changes } = setup();
  try {
    commit(store, projection, { runnerId: 'alice', sessionId: S2, sessionStartedAt: 30_000, records: [fix(0, 31_000), fix(1, 32_000)] }, 32_100);
    commit(store, projection, { runnerId: 'alice', sessionId: S1, sessionStartedAt: 20_000, records: [fix(0, 21_000), end(1, 22_000)] }, 40_000);
    assert.equal(changes.length, 2);
    assert.equal(changes[1]!.trackReset, true);
    assert.deepStrictEqual(changes[1]!.appendedPoints, []);
    assert.deepStrictEqual(projection.snapshot(0), replaySnapshot(store));
    assert.deepStrictEqual(projection.snapshot(0).tracks['alice']!.map((p) => p.recordedAt), [21_000, 31_000, 32_000]);
  } finally {
    store.close();
  }
});

test('an out-of-order batch within the session refolds without a reset when the track only grows', () => {
  const { store, projection, changes } = setup();
  try {
    const s1 = { runnerId: 'alice', sessionId: S1, sessionStartedAt: 20_000 };
    commit(store, projection, { ...s1, records: [fix(0, 21_000), fix(2, 23_000, 50)] }, 23_100);
    commit(store, projection, { ...s1, records: [fix(1, 22_000, 50)] }, 23_200);
    assert.equal(changes.at(-1)!.trackReset, false);
    assert.deepStrictEqual(projection.snapshot(0), replaySnapshot(store));
  } finally {
    store.close();
  }
});

test('a missed notification heals on the next batch, even a duplicate', () => {
  const { store, projection, changes } = setup();
  try {
    const s1 = { runnerId: 'alice', sessionId: S1, sessionStartedAt: 20_000, records: [fix(0, 21_000)] };
    store.appendBatch({ ...s1, receivedAt: 21_100 }); // committed, projection never told (it threw)
    commit(store, projection, s1, 22_000);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.appendedPoints.length, 1);
    assert.deepStrictEqual(projection.snapshot(0), replaySnapshot(store));
  } finally {
    store.close();
  }
});

test('onChange accepts a single listener; unknown runners are ignored', () => {
  const { store, projection, changes } = setup();
  try {
    assert.throws(() => projection.onChange(() => {}), /already/);
    commit(store, projection, { runnerId: 'carol', sessionId: S1, sessionStartedAt: 20_000, records: [fix(0, 21_000)] }, 21_100);
    assert.deepStrictEqual(changes, []);
  } finally {
    store.close();
  }
});

// ---- live = replay, whatever the batch order ----

/** mulberry32: small seeded PRNG so failures reproduce. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sessionRecords(random: () => number, startAt: number): IngestRecord[] {
  const records: IngestRecord[] = [];
  let seq = 0;
  let t = startAt;
  const count = 6 + Math.floor(random() * 10);
  const endAt = random() < 0.7 ? Math.floor(random() * count) : -1;
  for (let i = 0; i < count; i++) {
    seq += random() < 0.15 ? 2 : 1; // seq gaps happen
    t += random() < 0.15 ? -500 : 5_000; // so do clock steps back; 5 s steps let the 60 s pace window fill
    if (i === endAt) records.push(end(seq, t));
    else records.push(fix(seq, t, [5, 12, 30, 30.5, 80][Math.floor(random() * 5)]!));
  }
  return records;
}

function batchesOf(random: () => number, session: Omit<Batch, 'records'>, records: IngestRecord[]): Batch[] {
  const batches: Batch[] = [];
  for (let i = 0; i < records.length; ) {
    const size = 1 + Math.floor(random() * 4);
    batches.push({ ...session, records: records.slice(i, i + size) });
    // Overlapping resend: the ack was lost after the commit.
    if (random() < 0.3) batches.push({ ...session, records: records.slice(Math.max(0, i - 1), i + size + 1) });
    i += size;
  }
  return batches;
}

function shuffle<T>(random: () => number, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/** Interleaves queues keeping each queue's own order. */
function interleave<T>(random: () => number, queues: T[][]): T[] {
  const out: T[] = [];
  const pending = queues.map((q) => [...q]).filter((q) => q.length > 0);
  while (pending.length > 0) {
    const i = Math.floor(random() * pending.length);
    out.push(pending[i]!.shift()!);
    if (pending[i]!.length === 0) pending.splice(i, 1);
  }
  return out;
}

/** A viewer's model: starts from a snapshot and applies change events the way the hub delivers them. */
function viewer(projection: Projection) {
  let model = projection.snapshot(0);
  return {
    apply(change: RunnerChange) {
      if (change.trackReset) {
        model = structuredClone(projection.snapshot(0));
        return;
      }
      model.tracks[change.runnerId]!.push(...change.appendedPoints);
      model.runners = model.runners.map((v) => (v.runnerId === change.runnerId ? change.view : v));
    },
    model: () => model,
  };
}

for (const mode of ['shuffled', 'in-order'] as const) {
  test(`live state equals a fresh replay over seeded random batch orders (${mode})`, () => {
    const seen = { distance: 0, avgPace: 0, currentPace: 0 };
    for (let seed = 1; seed <= 60; seed++) {
      const random = rng(seed);
      const a1 = { runnerId: 'alice', sessionId: S1, sessionStartedAt: 20_000 };
      const a2 = { runnerId: 'alice', sessionId: S2, sessionStartedAt: 40_000 };
      const b1 = { runnerId: 'bob', sessionId: S3, sessionStartedAt: 30_000 };
      const queues = [a1, a2, b1].map((s) => batchesOf(random, s, sessionRecords(random, s.sessionStartedAt + 100)));
      // A well-behaved phone sends its sessions one after the other; bob's phone is independent.
      const batches = mode === 'shuffled' ? shuffle(random, queues.flat()) : interleave(random, [[...queues[0]!, ...queues[1]!], queues[2]!]);

      const store = openStore(':memory:');
      try {
        const projection = createProjection({ config, store });
        const client = viewer(projection);
        const changes: RunnerChange[] = [];
        projection.onChange((c) => {
          changes.push(c);
          client.apply(c);
        });
        let receivedAt = 50_000;
        for (const batch of batches) {
          const before = changes.length;
          commit(store, projection, batch, (receivedAt += 10));
          assert.ok(changes.length - before <= 1, 'at most one change per batch');
        }
        const live = projection.snapshot(0);
        assert.deepStrictEqual(live, replaySnapshot(store), `seed ${seed}`);
        assert.deepStrictEqual(client.model(), live, `seed ${seed}: the event stream rebuilds the state`);
        Snapshot.parse(live);
        for (const v of live.runners) {
          if (v.distanceM > 0) seen.distance++;
          if (v.avgPaceSPerKm !== null) seen.avgPace++;
          if (v.currentPaceSPerKm !== null) seen.currentPace++;
        }
        if (mode === 'in-order') assert.ok(changes.every((c) => !c.trackReset), `seed ${seed}: no reset for in-order sessions`);
      } finally {
        store.close();
      }
    }
    // The comparison covers non-trivial stats, not just their defaults.
    assert.ok(seen.distance > 0 && seen.avgPace > 0 && seen.currentPace > 0, JSON.stringify(seen));
  });
}

test('restart: a reopened file store replays to the same snapshot', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'rlt-projection-')), 'tracker.db');
  const first = setup(path);
  let before: Snapshot;
  try {
    commit(first.store, first.projection, { runnerId: 'alice', sessionId: S1, sessionStartedAt: 20_000, records: [fix(0, 21_000), fix(1, 22_000), end(2, 23_000)] }, 23_100);
    commit(first.store, first.projection, { runnerId: 'alice', sessionId: S2, sessionStartedAt: 30_000, records: [fix(0, 31_000)] }, 31_100);
    commit(first.store, first.projection, { runnerId: 'bob', sessionId: S3, sessionStartedAt: 25_000, records: [fix(0, 26_000), fix(1, 27_000, 40)] }, 27_100);
    before = first.projection.snapshot(0);
    assert.equal(before.runners[0]!.status, 'active');
    assert.equal(before.runners[1]!.status, 'active');
  } finally {
    first.store.close();
  }
  const second = openStore(path);
  try {
    assert.deepStrictEqual(createProjection({ config, store: second }).snapshot(0), before);
  } finally {
    second.close();
  }
});
