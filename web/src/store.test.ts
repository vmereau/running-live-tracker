import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunnerView, Snapshot } from '@running-live-tracker/shared';
import { createStore } from './store.ts';

const NOW = 1_800_000_000_000;

function view(runnerId: string, over: Partial<RunnerView> = {}): RunnerView {
  return {
    runnerId,
    status: 'notStarted',
    runStartedAt: null,
    runEndedAt: null,
    lastFixAt: null,
    lastReceivedAt: null,
    lastPosition: null,
    distanceM: 0,
    progressM: null,
    remainingM: null,
    progressFraction: null,
    offCourse: false,
    avgPaceSPerKm: null,
    currentPaceSPerKm: null,
    etaAt: null,
    ...over,
  };
}

const point = (i: number) => ({ lat: 48 + i / 1000, lon: 2, recordedAt: NOW - 10_000 + i });

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    serverNow: NOW,
    event: {
      eventId: 'e',
      name: 'Event',
      hasCourse: false,
      lengthM: null,
      runners: [
        { runnerId: 'alice', displayName: 'Alice', color: '#e6194b' },
        { runnerId: 'bob', displayName: 'Bob', color: '#3cb44b' },
      ],
    },
    runners: [
      view('alice', { status: 'active', lastReceivedAt: NOW - 1000, lastPosition: { lat: 48.001, lon: 2 } }),
      view('bob'),
    ],
    tracks: { alice: [point(0), point(1)] },
    ...over,
  };
}

test('snapshot is held as-is', () => {
  const store = createStore(() => NOW);
  const snap = snapshot();
  store.applySnapshot(snap);
  assert.deepStrictEqual(store.getState(), { snapshot: snap, offsetMs: 0 });
  assert.equal(store.getState().snapshot?.runners.length, 2);
});

test('runner event replaces only that view', () => {
  const store = createStore(() => NOW);
  store.applySnapshot(snapshot());
  const moved = view('alice', { status: 'active', lastPosition: { lat: 48.5, lon: 2.5 }, lastReceivedAt: NOW });
  store.applyRunner({ serverNow: NOW, view: moved });
  const runners = store.getState().snapshot!.runners;
  assert.deepStrictEqual(runners[0], moved);
  assert.deepStrictEqual(runners[1], view('bob'));
  assert.deepStrictEqual(store.getState().snapshot!.tracks, snapshot().tracks);
});

test('runner event for a runner missing from the snapshot appends its view', () => {
  const store = createStore(() => NOW);
  const snap = snapshot({ runners: [snapshot().runners[0]!] });
  store.applySnapshot(snap);
  const bob = view('bob', { status: 'active', lastPosition: { lat: 48.2, lon: 2.2 } });
  store.applyRunner({ serverNow: NOW, view: bob });
  const runners = store.getState().snapshot!.runners;
  assert.deepStrictEqual(runners.map((r) => r.runnerId), ['alice', 'bob']);
  assert.equal(runners[0], snap.runners[0]);
  assert.deepStrictEqual(runners[1], bob);
});

test('track event appends points in order', () => {
  const store = createStore(() => NOW);
  store.applySnapshot(snapshot());
  store.applyTrack({ serverNow: NOW, runnerId: 'alice', points: [point(2), point(3), point(4)] });
  store.applyTrack({ serverNow: NOW, runnerId: 'bob', points: [point(9)] });
  const tracks = store.getState().snapshot!.tracks;
  assert.deepStrictEqual(tracks.alice, [0, 1, 2, 3, 4].map(point));
  assert.deepStrictEqual(tracks.bob, [point(9)]);
});

test('runner and track events before the first snapshot are ignored', () => {
  const store = createStore(() => NOW);
  let calls = 0;
  store.subscribe(() => calls++);
  store.applyRunner({ serverNow: NOW + 5000, view: view('alice') });
  store.applyTrack({ serverNow: NOW + 5000, runnerId: 'alice', points: [point(0)] });
  assert.deepStrictEqual(store.getState(), { snapshot: null, offsetMs: 0 });
  assert.equal(calls, 0);
});

test('a second snapshot replaces the state completely', () => {
  const store = createStore(() => NOW);
  store.applySnapshot(snapshot());
  store.applyTrack({ serverNow: NOW, runnerId: 'alice', points: [point(2)] });
  const fresh = snapshot({ runners: [view('bob')], tracks: {} });
  store.applySnapshot(fresh);
  assert.deepStrictEqual(store.getState().snapshot, fresh);
  assert.equal(store.getState().snapshot!.tracks.alice, undefined);
});

test('every payload sets offsetMs from serverNow and now() follows server time', () => {
  let local = NOW;
  const store = createStore(() => local);
  store.applySnapshot(snapshot({ serverNow: NOW + 5000 }));
  assert.equal(store.getState().offsetMs, 5000);
  assert.equal(store.now(), NOW + 5000);
  local = NOW + 1000;
  store.applyRunner({ serverNow: NOW - 1000, view: view('bob') });
  assert.equal(store.getState().offsetMs, -2000);
  store.applyTrack({ serverNow: NOW + 4000, runnerId: 'alice', points: [] });
  assert.equal(store.getState().offsetMs, 3000);
  assert.equal(store.now(), NOW + 4000);
});

test('subscribers are notified per change and can unsubscribe', () => {
  const store = createStore(() => NOW);
  const seen: number[] = [];
  const off = store.subscribe((s) => seen.push(s.snapshot?.runners.length ?? -1));
  store.applySnapshot(snapshot());
  off();
  store.applySnapshot(snapshot({ runners: [] }));
  assert.deepStrictEqual(seen, [2]);
});
