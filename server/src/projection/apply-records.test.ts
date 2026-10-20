import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunnerView } from '@running-live-tracker/shared';
import { applyRecords, compareRunKeys, initialRunnerState, isAccepted, toRunnerView } from './apply-records.ts';
import type { RunRecord } from './apply-records.ts';
import { initialRunnerView } from './snapshot.ts';

const S1 = '00000000-0000-4000-8000-000000000001';
const S2 = '00000000-0000-4000-8000-000000000002';

function fix(seq: number, recordedAt: number, opts: Partial<RunRecord> = {}): RunRecord {
  return {
    sessionStartedAt: 100,
    sessionId: S1,
    seq,
    kind: 'fix',
    recordedAt,
    receivedAt: recordedAt + 50,
    lat: 48 + seq / 1000,
    lon: 2 + seq / 1000,
    accuracyM: 5,
    ...opts,
  };
}

function end(seq: number, recordedAt: number, opts: Partial<RunRecord> = {}): RunRecord {
  return { ...fix(seq, recordedAt, opts), kind: 'end', lat: null, lon: null, accuracyM: null, ...opts };
}

const fold = (records: RunRecord[]) => applyRecords(initialRunnerState('alice'), records);

test('initial state projects to the notStarted contract defaults', () => {
  const view = toRunnerView(initialRunnerState('alice'));
  assert.deepStrictEqual(view, initialRunnerView('alice'));
  RunnerView.parse(view);
});

test('first accepted fix: active, runStartedAt = lastFixAt = recordedAt, one track point', () => {
  const state = fold([fix(0, 1_000)]);
  const view = RunnerView.parse(toRunnerView(state));
  assert.equal(view.status, 'active');
  assert.equal(view.runStartedAt, 1_000);
  assert.equal(view.lastFixAt, 1_000);
  assert.equal(view.lastReceivedAt, 1_050);
  assert.deepStrictEqual(view.lastPosition, { lat: 48, lon: 2 });
  assert.deepStrictEqual(state.track, [{ lat: 48, lon: 2, recordedAt: 1_000 }]);
  // Epic 3 fields keep their defaults.
  assert.equal(view.distanceM, 0);
  assert.equal(view.offCourse, false);
  for (const key of ['progressM', 'remainingM', 'progressFraction', 'avgPaceSPerKm', 'currentPaceSPerKm', 'etaAt'] as const) {
    assert.equal(view[key], null, key);
  }
});

test('accuracy 30 is accepted, 30.1 is not but still updates lastReceivedAt', () => {
  const at30 = fold([fix(0, 1_000, { accuracyM: 30 })]);
  assert.equal(at30.status, 'active');
  assert.equal(at30.track.length, 1);

  const poor = fold([fix(0, 1_000), fix(1, 2_000, { accuracyM: 30.1, receivedAt: 9_000 })]);
  assert.equal(poor.track.length, 1);
  assert.equal(poor.lastFixAt, 1_000);
  assert.equal(poor.lastReceivedAt, 9_000);

  const onlyPoor = fold([fix(0, 1_000, { accuracyM: 31 })]);
  assert.equal(onlyPoor.status, 'notStarted');
  assert.equal(onlyPoor.runStartedAt, null);
  assert.equal(onlyPoor.lastReceivedAt, 1_050);
});

test('a fix with recordedAt <= lastFixAt is ignored except for lastReceivedAt', () => {
  const state = fold([fix(0, 2_000), fix(1, 2_000, { receivedAt: 5_000 }), fix(2, 1_500, { receivedAt: 6_000 })]);
  assert.equal(state.track.length, 1);
  assert.equal(state.lastFixAt, 2_000);
  assert.deepStrictEqual(state.lastPosition, { lat: 48, lon: 2 });
  assert.equal(state.lastReceivedAt, 6_000);
});

test('lastReceivedAt is the max, not the last', () => {
  const state = fold([fix(0, 1_000, { receivedAt: 9_000 }), fix(1, 2_000, { receivedAt: 3_000 })]);
  assert.equal(state.lastReceivedAt, 9_000);
});

test('end then an accepted fix in a new session: stopped with runEndedAt, then active with runEndedAt null', () => {
  const s1 = [fix(0, 1_000), fix(1, 2_000), end(2, 2_500)];
  const stopped = fold(s1);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.runEndedAt, 2_500);
  assert.equal(stopped.lastFixAt, 2_000);

  const resumed = applyRecords(stopped, [fix(0, 3_000, { sessionId: S2, sessionStartedAt: 2_900 })]);
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.runEndedAt, null);
  assert.equal(resumed.runStartedAt, 1_000, 'runStartedAt is set by the first accepted fix only');
  assert.equal(resumed.track.length, 3);
});

test('a rejected fix after an end keeps the runner stopped', () => {
  const state = fold([fix(0, 1_000), end(1, 2_000), fix(0, 3_000, { sessionId: S2, sessionStartedAt: 2_900, accuracyM: 50 })]);
  assert.equal(state.status, 'stopped');
  assert.equal(state.runEndedAt, 2_000);
});

test("records after their session's end are ignored completely", () => {
  const state = fold([fix(0, 1_000), end(1, 2_000), fix(2, 3_000, { receivedAt: 99_000 }), end(3, 4_000, { receivedAt: 99_000 })]);
  assert.equal(state.status, 'stopped');
  assert.equal(state.runEndedAt, 2_000);
  assert.equal(state.track.length, 1);
  assert.equal(state.lastReceivedAt, 2_050);
  assert.deepStrictEqual(state.lastKey, { sessionStartedAt: 100, sessionId: S1, seq: 3 });
});

test('an end while notStarted changes nothing but lastReceivedAt', () => {
  const state = fold([end(0, 1_000)]);
  assert.deepStrictEqual(toRunnerView(state), { ...initialRunnerView('alice'), lastReceivedAt: 1_050 });
  // ...and still closes its session.
  assert.equal(applyRecords(state, [fix(1, 2_000)]).status, 'notStarted');
  assert.equal(applyRecords(state, [fix(0, 2_000, { sessionId: S2, sessionStartedAt: 1_500 })]).status, 'active');
});

test('applyRecords is pure, and folding in chunks equals folding at once', () => {
  const records = [fix(0, 1_000), fix(1, 2_000, { accuracyM: 99 }), fix(2, 3_000), end(3, 4_000), fix(0, 5_000, { sessionId: S2, sessionStartedAt: 4_500 })];
  const initial = initialRunnerState('alice');
  const frozen = structuredClone(initial);
  const whole = applyRecords(initial, records);
  assert.deepStrictEqual(initial, frozen);
  const first = applyRecords(initial, records.slice(0, 2));
  const firstCopy = structuredClone(first);
  const chunked = applyRecords(first, records.slice(2));
  assert.deepStrictEqual(first, firstCopy, 'the earlier state is not mutated');
  assert.deepStrictEqual(chunked, whole);
  assert.deepStrictEqual(applyRecords(whole, []), whole);
});

test('isAccepted: fix, accuracy <= 30, strictly after lastFixAt', () => {
  assert.equal(isAccepted({ lastFixAt: null }, fix(0, 0)), true);
  assert.equal(isAccepted({ lastFixAt: 10 }, fix(0, 11)), true);
  assert.equal(isAccepted({ lastFixAt: 10 }, fix(0, 10)), false);
  assert.equal(isAccepted({ lastFixAt: null }, end(0, 10)), false);
  assert.equal(isAccepted({ lastFixAt: null }, fix(0, 10, { accuracyM: 30.0001 })), false);
});

test('compareRunKeys orders by sessionStartedAt, then sessionId, then seq', () => {
  const k = (sessionStartedAt: number, sessionId: string, seq: number) => ({ sessionStartedAt, sessionId, seq });
  assert.ok(compareRunKeys(k(1, S2, 9), k(2, S1, 0)) < 0);
  assert.ok(compareRunKeys(k(2, S1, 9), k(2, S2, 0)) < 0);
  assert.ok(compareRunKeys(k(2, S1, 1), k(2, S1, 0)) > 0);
  assert.equal(compareRunKeys(k(2, S1, 1), k(2, S1, 1)), 0);
});

// ---- Story 3.1: distance and pace ----

/** A fix `metres` north of (48, 2), on one meridian so distances add up exactly. */
const north = (seq: number, recordedAt: number, metres: number, opts: Partial<RunRecord> = {}): RunRecord =>
  fix(seq, recordedAt, { lat: 48 + metres / 111_194.93, lon: 2, ...opts });

/** 11 m every 3.3 s (300 s/km) for 41 fixes: 440 m in 132 s. */
const steady = () => Array.from({ length: 41 }, (_, i) => north(i, 1_000 + i * 3_300, i * 11));

test('stats: distance sums the accepted segments; paces at 5:00 /km', () => {
  const records = steady();
  const view = RunnerView.parse(toRunnerView(fold(records)));
  assert.ok(Math.abs(view.distanceM - 440) < 0.01, String(view.distanceM));
  assert.ok(Math.abs(view.avgPaceSPerKm! - 300) < 0.01, String(view.avgPaceSPerKm));
  assert.ok(Math.abs(view.currentPaceSPerKm! - 300) < 0.01, String(view.currentPaceSPerKm));
});

test('stats: a rejected fix leaves distance and paces unchanged', () => {
  const base = fold(steady());
  const after = applyRecords(base, [
    north(41, 200_000, 2_000, { accuracyM: 31 }),
    north(42, 1_000, 5_000), // recordedAt not after lastFixAt
  ]);
  assert.equal(after.distanceM, base.distanceM);
  assert.deepStrictEqual(after.paceSamples, base.paceSamples);
  const before = toRunnerView(base);
  const view = toRunnerView(after);
  assert.equal(view.distanceM, before.distanceM);
  assert.equal(view.avgPaceSPerKm, before.avgPaceSPerKm);
  assert.equal(view.currentPaceSPerKm, before.currentPaceSPerKm);
});

test('stats: stopped nulls the current pace only', () => {
  const records = steady();
  const active = toRunnerView(fold(records));
  const stopped = RunnerView.parse(toRunnerView(fold([...records, end(41, 200_000)])));
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.currentPaceSPerKm, null);
  assert.equal(stopped.distanceM, active.distanceM);
  assert.equal(stopped.avgPaceSPerKm, active.avgPaceSPerKm);
});

test('stats: S1 end then S2 fix keeps summing distance across sessions', () => {
  const s1 = [north(0, 1_000, 0), north(1, 31_000, 100), north(2, 61_000, 200), end(3, 62_000)];
  const stopped = fold(s1);
  const resumed = applyRecords(stopped, [north(0, 91_000, 300, { sessionId: S2, sessionStartedAt: 90_000 })]);
  const view = RunnerView.parse(toRunnerView(resumed));
  assert.equal(view.status, 'active');
  assert.ok(Math.abs(view.distanceM - 300) < 0.01, String(view.distanceM));
  assert.ok(Math.abs(view.avgPaceSPerKm! - 90 / 0.3) < 0.01, String(view.avgPaceSPerKm));
  assert.ok(view.currentPaceSPerKm !== null && view.currentPaceSPerKm > 0);
});

test('stats: below 100 m and before the 60 s / 200 m window both paces are null', () => {
  const short = RunnerView.parse(toRunnerView(fold([north(0, 1_000, 0), north(1, 61_000, 99)])));
  assert.equal(short.avgPaceSPerKm, null);
  assert.equal(short.currentPaceSPerKm, null);
  const fast = RunnerView.parse(toRunnerView(fold([north(0, 1_000, 0), north(1, 51_000, 300)])));
  assert.ok(fast.avgPaceSPerKm !== null);
  assert.equal(fast.currentPaceSPerKm, null, '300 m in 50 s');
  const slow = RunnerView.parse(toRunnerView(fold([north(0, 1_000, 0), north(1, 91_000, 150)])));
  assert.equal(slow.currentPaceSPerKm, null, '150 m in 90 s');
});

test('stats: pace samples are pruned to the current window, identically in chunks', () => {
  const records = steady();
  const whole = fold(records);
  // 18 steps are 59.4 s and 198 m, 19 steps 62.7 s and 209 m: the window starts 19 samples back.
  assert.equal(whole.paceSamples.length, 20);
  let chunked = initialRunnerState('alice');
  for (let i = 0; i < records.length; i += 7) chunked = applyRecords(chunked, records.slice(i, i + 7));
  assert.deepStrictEqual(chunked, whole);
});
