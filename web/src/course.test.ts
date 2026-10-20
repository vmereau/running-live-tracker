import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunnerView, Snapshot } from '@running-live-tracker/shared';
import { COURSE_URL, type FetchCourse, parseCourse, watchCourse } from './course.ts';
import type { LatLon } from './camera.ts';
import { createStore } from './store.ts';

const NOW = 1_800_000_000_000;
const BODY = { type: 'LineString', coordinates: [[2.33, 48.84], [2.34, 48.85]] };
const POINTS: LatLon[] = [{ lat: 48.84, lon: 2.33 }, { lat: 48.85, lon: 2.34 }];

function view(runnerId: string): RunnerView {
  return {
    runnerId, status: 'notStarted', runStartedAt: null, runEndedAt: null, lastFixAt: null, lastReceivedAt: null,
    lastPosition: null, distanceM: 0, progressM: null, remainingM: null, progressFraction: null, offCourse: false,
    avgPaceSPerKm: null, currentPaceSPerKm: null, etaAt: null,
  };
}

function snapshot(hasCourse: boolean): Snapshot {
  return {
    serverNow: NOW,
    event: {
      eventId: 'e', name: 'E', hasCourse, lengthM: hasCourse ? 1500 : null,
      runners: [{ runnerId: 'alice', displayName: 'Alice', color: '#e6194b' }],
    },
    runners: [view('alice')],
    tracks: { alice: [] },
  };
}

type Reply = { ok: boolean; status: number; body?: unknown } | 'network';

/** A fake fetch answering from `replies` in order, recording the URLs. */
function fakeFetch(replies: Reply[]) {
  const calls: string[] = [];
  const fetchCourse: FetchCourse = async (url) => {
    calls.push(url);
    const reply = replies.shift() ?? 'network';
    if (reply === 'network') throw new TypeError('Failed to fetch');
    return { ok: reply.ok, status: reply.status, json: async () => reply.body };
  };
  return { calls, fetchCourse };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function silenceWarn(t: { after: (fn: () => void) => void }) {
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args);
  t.after(() => (console.warn = original));
  return warnings;
}

test('parseCourse swaps [lon, lat] to {lat, lon}', () => {
  assert.deepStrictEqual(parseCourse(BODY), POINTS);
});

test('parseCourse rejects an invalid body (one point, wrong type, swapped out-of-range)', () => {
  assert.throws(() => parseCourse({ type: 'LineString', coordinates: [[2, 48]] }));
  assert.throws(() => parseCourse({ type: 'Point', coordinates: [[2, 48], [3, 49]] }));
  assert.throws(() => parseCourse({ type: 'LineString', coordinates: [[2, 120], [3, 49]] }));
});

test('hasCourse: fetches once on the first snapshot and hands over the points; later changes never refetch', async () => {
  const store = createStore(() => NOW);
  const { calls, fetchCourse } = fakeFetch([{ ok: true, status: 200, body: BODY }]);
  const got: LatLon[][] = [];
  watchCourse(store, (p) => got.push(p), fetchCourse);
  store.applySnapshot(snapshot(true));
  store.applySnapshot(snapshot(true)); // while loading: no second fetch
  await flush();
  assert.deepStrictEqual(calls, [COURSE_URL]);
  assert.deepStrictEqual(got, [POINTS]);
  store.applySnapshot(snapshot(true));
  store.applyRunner({ serverNow: NOW, view: view('alice') });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(got.length, 1);
});

test('no course: never fetches', async () => {
  const store = createStore(() => NOW);
  const { calls, fetchCourse } = fakeFetch([]);
  watchCourse(store, () => assert.fail('no course expected'), fetchCourse);
  store.applySnapshot(snapshot(false));
  store.applySnapshot(snapshot(false));
  await flush();
  assert.deepStrictEqual(calls, []);
});

test('a failed fetch warns and is retried on the next snapshot, not on runner or track events', async (t) => {
  const warnings = silenceWarn(t);
  const store = createStore(() => NOW);
  const { calls, fetchCourse } = fakeFetch(['network', { ok: false, status: 502 }, { ok: true, status: 200, body: { type: 'LineString', coordinates: [] } }, { ok: true, status: 200, body: BODY }]);
  const got: LatLon[][] = [];
  watchCourse(store, (p) => got.push(p), fetchCourse);

  store.applySnapshot(snapshot(true));
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(warnings.length, 1);

  store.applyRunner({ serverNow: NOW, view: view('alice') });
  store.applyTrack({ serverNow: NOW, runnerId: 'alice', points: [] });
  await flush();
  assert.equal(calls.length, 1, 'runner and track events do not retry');

  store.applySnapshot(snapshot(true)); // non-200
  await flush();
  store.applySnapshot(snapshot(true)); // invalid body
  await flush();
  assert.equal(warnings.length, 3);
  assert.deepStrictEqual(got, []);

  store.applySnapshot(snapshot(true));
  await flush();
  assert.equal(calls.length, 4);
  assert.deepStrictEqual(got, [POINTS]);
});
