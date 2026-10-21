// Golden course progress (Story 3.4): records simulated along the shared GPX
// fixtures at a fixed pace, folded through the one projection fold with the same
// GPX as the event's course.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunnerView } from '@running-live-tracker/shared';
import { buildCourse } from '../domain/course.ts';
import type { Course } from '../domain/course.ts';
import { pointAtDistance } from '../domain/geo.ts';
import { parseGpx } from '../domain/gpx.ts';
import { REJOIN_FIXES } from '../domain/progress.ts';
import { applyRecords, initialRunnerState, toRunnerView } from './apply-records.ts';
import type { RunRecord } from './apply-records.ts';

const gpxDir = join(import.meta.dirname, '..', '..', '..', 'shared', 'fixtures', 'gpx');
const SESSION = '00000000-0000-4000-8000-000000000001';
const T0 = 1_000_000;
const PACE_S_PER_KM = 300; // 5:00 /km
const SPEED_MPS = 1000 / PACE_S_PER_KM;
const FIX_EVERY_S = 5;

const course = (name: string): Course => buildCourse(parseGpx(readFileSync(join(gpxDir, name), 'utf8')));

/**
 * One fix every 5 s at the planned pace, along course distances [fromM, toM],
 * skipping fixes whose course distance falls in `skip` (a gap). Time runs from the
 * course start, so a late start begins with a non-zero clock.
 */
function simulate(c: Course, fromM: number, toM: number, skip?: [number, number]): RunRecord[] {
  const records: RunRecord[] = [];
  for (let t = Math.ceil(fromM / SPEED_MPS / FIX_EVERY_S) * FIX_EVERY_S; t * SPEED_MPS <= toM; t += FIX_EVERY_S) {
    const d = t * SPEED_MPS;
    if (skip && d > skip[0] && d < skip[1]) continue;
    const p = pointAtDistance(c.points, c.cumulativeM, d);
    const recordedAt = T0 + t * 1000;
    records.push({ sessionStartedAt: T0, sessionId: SESSION, seq: records.length, kind: 'fix', recordedAt, receivedAt: recordedAt + 200, lat: p.lat, lon: p.lon, accuracyM: 5 });
  }
  return records;
}

/** Course distance of a simulated record. */
const courseM = (r: RunRecord) => ((r.recordedAt - T0) / 1000) * SPEED_MPS;

/** Every intermediate view, each through the contract schema. */
function foldAll(records: RunRecord[], c: Course | null): RunnerView[] {
  const views: RunnerView[] = [];
  let state = initialRunnerState('alice');
  for (const r of records) {
    state = applyRecords(state, [r], c);
    views.push(RunnerView.parse(toRunnerView(state, c)));
  }
  return views;
}

const near = (actual: number | null, expected: number, tolerance: number, label: string) =>
  assert.ok(actual !== null && Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);

function assertConsistent(v: RunnerView, c: Course) {
  assert.equal(v.distanceM, v.progressM);
  near(v.remainingM, c.lengthM - v.progressM!, 1e-6, 'remainingM');
  near(v.progressFraction, v.progressM! / c.lengthM, 1e-9, 'progressFraction');
}

test('out-and-back: ≈ 40 % at 40 %, ≈ lengthM at the end, never on the return leg early', () => {
  const c = course('out-and-back.gpx');
  const records = simulate(c, 0, c.lengthM);
  const views = foldAll(records, c);
  const at40 = records.findLastIndex((r) => courseM(r) <= c.lengthM * 0.4);
  near(views[at40]!.progressM, courseM(records[at40]!), c.lengthM * 0.01, 'progress at 40 %');
  near(views[at40]!.progressFraction, 0.4, 0.01, 'fraction at 40 %');
  near(views.at(-1)!.progressM, c.lengthM, c.lengthM * 0.01, 'final progress');
  for (const [i, v] of views.entries()) {
    near(v.progressM, courseM(records[i]!), c.lengthM * 0.01, `fix ${i}`);
    assert.equal(v.offCourse, false, `fix ${i}`);
    assertConsistent(v, c);
  }
  near(views.at(-1)!.avgPaceSPerKm, PACE_S_PER_KM, PACE_S_PER_KM * 0.01, 'avgPace');
  near(views.at(-1)!.currentPaceSPerKm, PACE_S_PER_KM, PACE_S_PER_KM * 0.02, 'currentPace');
});

test('out-and-back ETA at 5:00 /km: null before 1 km, then ≈ runStartedAt + lengthM × 0.3 s', () => {
  const c = course('out-and-back.gpx');
  const records = simulate(c, 0, c.lengthM);
  const views = foldAll(records, c);
  const expected = records[0]!.recordedAt + c.lengthM * (PACE_S_PER_KM / 1000) * 1000;
  let withEta = 0;
  for (const [i, v] of views.entries()) {
    if (v.distanceM < 1000) {
      assert.equal(v.etaAt, null, `fix ${i} at ${v.distanceM} m`);
      continue;
    }
    withEta++;
    near(v.etaAt, expected, c.lengthM * (PACE_S_PER_KM / 1000) * 1000 * 0.01, `ETA at fix ${i}`);
  }
  assert.ok(withEta > 0);
});

test('lap: ≈ 100 m at 100 m (never ≈ lengthM), ≈ lengthM at the end', () => {
  const c = course('lap.gpx');
  const records = simulate(c, 0, c.lengthM);
  const views = foldAll(records, c);
  const at100 = records.findLastIndex((r) => courseM(r) <= 100);
  near(views[0]!.progressM, 0, c.lengthM * 0.01, 'first fix');
  near(views[at100]!.progressM, 100, c.lengthM * 0.01, 'progress at 100 m');
  near(views.at(-1)!.progressM, c.lengthM, c.lengthM * 0.01, 'final progress');
  for (const v of views) assertConsistent(v, c);
});

test('late Start at 70 % of straight: a rejoin jump, then progress ≈ lengthM; paces stay near the planned pace', () => {
  const c = course('straight.gpx');
  const records = simulate(c, c.lengthM * 0.7, c.lengthM);
  const views = foldAll(records, c);
  for (const v of views.slice(0, REJOIN_FIXES - 1)) {
    assert.equal(v.offCourse, true);
    assert.equal(v.progressM, 0);
  }
  const jump = views[REJOIN_FIXES - 1]!;
  assert.equal(jump.offCourse, false);
  near(jump.progressM, courseM(records[REJOIN_FIXES - 1]!), c.lengthM * 0.01, 'jump');
  const last = views.at(-1)!;
  near(last.progressM, c.lengthM, c.lengthM * 0.01, 'final progress');
  assert.equal(last.runStartedAt, records[0]!.recordedAt);
  // Skipped metres never count in pace: the current pace is the planned one, and the
  // average pace only carries the off-course fixes' time (no distance before the jump).
  near(last.currentPaceSPerKm, PACE_S_PER_KM, PACE_S_PER_KM * 0.02, 'currentPace');
  const elapsedS = (last.lastFixAt! - last.runStartedAt!) / 1000;
  const offCourseS = (records[REJOIN_FIXES - 1]!.recordedAt - records[0]!.recordedAt) / 1000;
  near(last.avgPaceSPerKm, (PACE_S_PER_KM * elapsedS) / (elapsedS - offCourseS), PACE_S_PER_KM * 0.01, 'avgPace');
  for (const v of views) {
    if (v.currentPaceSPerKm !== null) near(v.currentPaceSPerKm, PACE_S_PER_KM, PACE_S_PER_KM * 0.02, 'currentPace');
    if (v.avgPaceSPerKm !== null) assert.ok(v.avgPaceSPerKm > PACE_S_PER_KM * 0.99, `avg ${v.avgPaceSPerKm}`);
  }
});

test('2 km gap on out-and-back [100, 2150]: the grown window lands on the return leg; final ≈ lengthM', () => {
  const c = course('out-and-back.gpx');
  const gap: [number, number] = [100, 2150];
  const records = simulate(c, 0, c.lengthM, gap);
  const views = foldAll(records, c);
  const after = records.findIndex((r) => courseM(r) >= gap[1]);
  assert.ok(courseM(records[after]!) - courseM(records[after - 1]!) >= 2000, 'the gap spans more than 2 km of course');
  near(views[after]!.progressM, courseM(records[after]!), c.lengthM * 0.01, 'first fix after the gap');
  near(views.at(-1)!.progressM, c.lengthM, c.lengthM * 0.01, 'final progress');
  for (const v of views) assert.equal(v.offCourse, false);
});

test('no course: progress fields and ETA null, offCourse false, distance the raw sum', () => {
  const c = course('out-and-back.gpx');
  const views = foldAll(simulate(c, 0, c.lengthM), null);
  for (const v of views) {
    assert.equal(v.progressM, null);
    assert.equal(v.remainingM, null);
    assert.equal(v.progressFraction, null);
    assert.equal(v.offCourse, false);
    assert.equal(v.etaAt, null);
  }
  near(views.at(-1)!.distanceM, c.lengthM, c.lengthM * 0.01, 'distanceM');
});
