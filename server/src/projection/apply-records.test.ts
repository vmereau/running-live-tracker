import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunnerView } from '@running-live-tracker/shared';
import { applyRecords, compareRunKeys, initialRunnerState, isAccepted, toRunnerView } from './apply-records.ts';
import type { RunRecord } from './apply-records.ts';
import { initialRunnerView } from './snapshot.ts';
import { buildCourse } from '../domain/course.ts';

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

// ---- course progress (Story 3.4) ----

const DEG_M = (6_371_000 * Math.PI) / 180;
const KX = DEG_M * Math.cos((48 * Math.PI) / 180);
/** Course point / fix position `y` m north and `x` m east of (48, 2). */
const at = (y: number, x = 0) => ({ lat: 48 + y / DEG_M, lon: 2 + x / KX });
/** A straight-north course, one point every 100 m. */
const straightCourse = (lengthM: number) => buildCourse(Array.from({ length: lengthM / 100 + 1 }, (_, i) => at(i * 100)));
const SPEED = 1000 / 300; // 5:00 /km

/** One fix every 5 s along [fromM, toM] of the straight-north layout, at 5:00 /km. */
function northFixes(fromM: number, toM: number, opts: { t0?: number; seq0?: number; x?: number; sessionId?: string } = {}): RunRecord[] {
  const { t0 = 1_000_000, seq0 = 0, x = 0, sessionId = S1 } = opts;
  const out: RunRecord[] = [];
  for (let t = 0; fromM + t * SPEED <= toM; t += 5) {
    const p = at(fromM + t * SPEED, x);
    out.push(fix(seq0 + out.length, t0 + t * 1000, { ...p, sessionId }));
  }
  return out;
}

test('progress: without a course the four fields keep their defaults and distance is the raw sum', () => {
  const records = northFixes(0, 500);
  const view = RunnerView.parse(toRunnerView(applyRecords(initialRunnerState('alice'), records)));
  assert.equal(view.progressM, null);
  assert.equal(view.remainingM, null);
  assert.equal(view.progressFraction, null);
  assert.equal(view.offCourse, false);
  assert.ok(Math.abs(view.distanceM - 500) < 2);
});

test('progress: with a course but no accepted fix, the fields are null and offCourse false', () => {
  const course = straightCourse(2000);
  const state = applyRecords(initialRunnerState('alice'), [fix(0, 1_000, { accuracyM: 80 })], course);
  const view = RunnerView.parse(toRunnerView(state, course));
  assert.equal(state.progress, null);
  assert.deepStrictEqual(
    [view.progressM, view.remainingM, view.progressFraction, view.offCourse, view.distanceM],
    [null, null, null, false, 0],
  );
});

test('progress: with a course, distance = progressM; remaining and fraction follow lengthM', () => {
  const course = straightCourse(2000);
  const view = RunnerView.parse(toRunnerView(applyRecords(initialRunnerState('alice'), northFixes(0, 500), course), course));
  assert.ok(view.progressM !== null && Math.abs(view.progressM - 500) < 2, String(view.progressM));
  assert.equal(view.distanceM, view.progressM);
  assert.equal(view.remainingM, course.lengthM - view.progressM);
  assert.equal(view.progressFraction, view.progressM / course.lengthM);
  assert.equal(view.offCourse, false);
  assert.ok(view.avgPaceSPerKm !== null && Math.abs(view.avgPaceSPerKm - 300) < 3);
});

test('progress: folding in chunks equals folding at once', () => {
  const course = straightCourse(5000);
  const records = [...northFixes(0, 300), ...northFixes(2000, 2400, { t0: 1_100_000, seq0: 100 })];
  const once = applyRecords(initialRunnerState('alice'), records, course);
  const chunked = applyRecords(applyRecords(initialRunnerState('alice'), records.slice(0, 40), course), records.slice(40), course);
  assert.deepStrictEqual(chunked, once);
});

test('progress: late Start at 40 %: paces stay near the true pace after the jump (skipped metres excluded)', () => {
  const course = straightCourse(5000);
  const records = northFixes(2000, 5000);
  const states: RunnerView[] = [];
  let state = initialRunnerState('alice');
  for (const r of records) {
    state = applyRecords(state, [r], course);
    states.push(RunnerView.parse(toRunnerView(state, course)));
  }
  for (const v of states.slice(0, 5)) {
    assert.equal(v.offCourse, true);
    assert.equal(v.progressM, 0);
  }
  assert.ok(states[5]!.progressM! > 2000);
  for (const v of states) {
    // The 5 off-course fixes add elapsed time without distance: at most ~25 s over the run.
    if (v.avgPaceSPerKm !== null) assert.ok(v.avgPaceSPerKm > 290, `avg ${v.avgPaceSPerKm}`);
    if (v.currentPaceSPerKm !== null) assert.ok(Math.abs(v.currentPaceSPerKm - 300) < 6, `current ${v.currentPaceSPerKm}`);
  }
  const last = states.at(-1)!;
  assert.ok(Math.abs(last.progressM! - 5000) < 2);
  assert.ok(Math.abs(last.avgPaceSPerKm! - 300) < 300 * 0.05, `avg ${last.avgPaceSPerKm}`);
  assert.ok(Math.abs(last.currentPaceSPerKm! - 300) < 6);
});

test('progress: a new session restarts the window clock, so a long pause on an out-and-back stays outbound', () => {
  // Out north 1500 m, back south 30 m to the east.
  const course = buildCourse([
    ...Array.from({ length: 16 }, (_, i) => at(i * 100)),
    ...Array.from({ length: 16 }, (_, i) => at(1500 - i * 100, 30)),
  ]);
  const s1 = northFixes(0, 300);
  const lastAt = s1.at(-1)!.recordedAt;
  const s2 = northFixes(310, 400, { t0: lastAt + 3_600_000, sessionId: S2 }).map((r) => ({ ...r, sessionStartedAt: lastAt + 3_600_000 }));
  const records = [...s1, end(s1.length, lastAt + 1_000), ...s2];
  const view = toRunnerView(applyRecords(initialRunnerState('alice'), records, course), course);
  assert.ok(Math.abs(view.progressM! - (310 + 25 * SPEED)) < 2, String(view.progressM)); // the last fix, 25 s after resuming
  // The same pause inside one session (no Stop) keeps the grown window.
  // A rejoin begun before the Stop does not carry into the new session.
  // Five fixes on the outbound leg beyond the window (which ends at ≈ 1300 m).
  const offAhead = Array.from({ length: 5 }, (_, i) => fix(s1.length + i, lastAt + 5_000 * (i + 1), at(1_450 + i * 15)));
  const beforeStop = applyRecords(initialRunnerState('alice'), [...s1, ...offAhead.slice(0, 5)], course);
  assert.equal(beforeStop.progress!.rejoinCount, 5);
  const resumed = applyRecords(beforeStop, [{ ...s2[0]!, ...at(1_530) }], course);
  assert.equal(resumed.progress!.rejoinCount, 1, 'the count restarts with the resumed session');
  assert.ok(resumed.progress!.progressM < 400, String(resumed.progress!.progressM));
  const sameSession = toRunnerView(applyRecords(initialRunnerState('alice'), [...s1, ...s2.map((r) => ({ ...r, sessionId: S1, sessionStartedAt: 100 }))], course), course);
  assert.ok(sameSession.progressM! > 1500, String(sameSession.progressM));
});

test('progress: a late Start inside the first window counts the start position as skipped, not in pace', () => {
  const course = straightCourse(5000);
  const records = northFixes(800, 3000);
  const state = applyRecords(initialRunnerState('alice'), records, course);
  const view = RunnerView.parse(toRunnerView(state, course));
  assert.ok(Math.abs(state.progress!.skippedM - 800) < 1, String(state.progress!.skippedM));
  assert.ok(Math.abs(view.progressM! - 3000) < 2, String(view.progressM));
  assert.ok(Math.abs(view.avgPaceSPerKm! - 300) < 3, `avg ${view.avgPaceSPerKm}`);
  assert.ok(Math.abs(view.currentPaceSPerKm! - 300) < 6, `current ${view.currentPaceSPerKm}`);
});

// ---- estimated finish time (Story 3.5) ----

test('eta: with a course, null before 1000 m, then lastFixAt + remaining × avg pace; null after end', () => {
  const course = straightCourse(3000);
  const records = northFixes(0, 1500);
  let state = initialRunnerState('alice');
  let sawEta = false;
  for (const r of records) {
    state = applyRecords(state, [r], course);
    const view = RunnerView.parse(toRunnerView(state, course));
    if (view.distanceM < 1000) {
      assert.equal(view.etaAt, null, `at ${view.distanceM} m`);
    } else {
      sawEta = true;
      assert.equal(view.etaAt, view.lastFixAt! + Math.round(view.remainingM! * view.avgPaceSPerKm!));
      // ≈ start + course length at 5:00 /km.
      assert.ok(Math.abs(view.etaAt! - (1_000_000 + 3000 * 300)) < 3000 * 300 * 0.01, String(view.etaAt));
    }
  }
  assert.ok(sawEta);
  const stopped = RunnerView.parse(toRunnerView(applyRecords(state, [end(records.length, records.at(-1)!.recordedAt + 1_000)], course), course));
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.etaAt, null);
});

test('eta: null without a course', () => {
  const view = RunnerView.parse(toRunnerView(applyRecords(initialRunnerState('alice'), northFixes(0, 1500))));
  assert.ok(view.distanceM >= 1000);
  assert.equal(view.etaAt, null);
});
