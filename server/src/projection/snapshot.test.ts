import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventInfo, Snapshot } from '@running-live-tracker/shared';
import type { EventConfig } from '../config/load-config.ts';
import { buildEventInfo, buildSnapshot, initialRunnerView } from './snapshot.ts';

const config: EventConfig = {
  eventId: 'test-run',
  name: 'Test run',
  opensAt: 1,
  closesAt: 2,
  coursePath: 'config/courses/secret.gpx',
  runners: [
    { runnerId: 'alice', displayName: 'Alice', color: '#e6194b', keyHash: 'a'.repeat(64) },
    { runnerId: 'bob', displayName: 'Bob', color: '#3cb44b', keyHash: 'b'.repeat(64) },
  ],
};

test('buildEventInfo copies public fields only and passes the strict schema', () => {
  const info = buildEventInfo(config);
  assert.deepStrictEqual(EventInfo.parse(info), {
    eventId: 'test-run',
    name: 'Test run',
    hasCourse: false,
    lengthM: null,
    runners: [
      { runnerId: 'alice', displayName: 'Alice', color: '#e6194b' },
      { runnerId: 'bob', displayName: 'Bob', color: '#3cb44b' },
    ],
  });
});

test('buildSnapshot has one notStarted view and an empty track per runner, in config order', () => {
  const snap = Snapshot.parse(buildSnapshot(config, 1_760_000_000_000, new Map()));
  assert.equal(snap.serverNow, 1_760_000_000_000);
  assert.deepStrictEqual(
    snap.runners.map((r) => r.runnerId),
    ['alice', 'bob'],
  );
  for (const view of snap.runners) {
    assert.equal(view.status, 'notStarted');
    assert.equal(view.distanceM, 0);
    assert.equal(view.offCourse, false);
    for (const key of ['runStartedAt', 'runEndedAt', 'lastFixAt', 'lastReceivedAt', 'lastPosition', 'progressM', 'remainingM', 'progressFraction', 'avgPaceSPerKm', 'currentPaceSPerKm', 'etaAt'] as const) {
      assert.equal(view[key], null, key);
    }
  }
  assert.deepStrictEqual(snap.tracks, { alice: [], bob: [] });
});

test('snapshot JSON never contains keyHash or the course path', () => {
  const json = JSON.stringify(buildSnapshot(config, 0, new Map()));
  assert.ok(!json.includes('keyHash'));
  assert.ok(!json.includes('a'.repeat(64)));
  assert.ok(!json.includes('b'.repeat(64)));
  assert.ok(!json.includes('secret.gpx'));
});

test('buildSnapshot uses the projected view and track, in config order, ignoring unknown runners', () => {
  const view = { ...initialRunnerView('bob'), status: 'active' as const, runStartedAt: 5, lastFixAt: 5, lastReceivedAt: 6, lastPosition: { lat: 1, lon: 2 } };
  const track = [{ lat: 1, lon: 2, recordedAt: 5 }];
  const projected = new Map([
    ['bob', { view, track }],
    ['carol', { view: initialRunnerView('carol'), track: [] }],
  ]);
  const snap = Snapshot.parse(buildSnapshot(config, 10, projected));
  assert.deepStrictEqual(snap.runners, [initialRunnerView('alice'), view]);
  assert.deepStrictEqual(snap.tracks, { alice: [], bob: track });
});
