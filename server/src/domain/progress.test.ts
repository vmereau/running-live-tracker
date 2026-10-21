import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCourse } from './course.ts';
import type { Course } from './course.ts';
import { EARTH_RADIUS_M } from './geo.ts';
import type { LatLon } from './geo.ts';
import { advanceProgress, matchOnCourse, REJOIN_FIXES, startProgress } from './progress.ts';
import type { CourseProgress, ProgressFix } from './progress.ts';

// Local metric plane around (48, 2): x east, y north, in metres.
const LAT0 = 48;
const LON0 = 2;
const DEG_M = (EARTH_RADIUS_M * Math.PI) / 180;
const at = (x: number, y: number): LatLon => ({ lat: LAT0 + y / DEG_M, lon: LON0 + x / (DEG_M * Math.cos((LAT0 * Math.PI) / 180)) });
const course = (xy: [number, number][]): Course => buildCourse(xy.map(([x, y]) => at(x, y)));

/** Straight north, `lengthM` long, one point every 100 m. */
const straight = (lengthM: number) => course(Array.from({ length: lengthM / 100 + 1 }, (_, i) => [0, i * 100] as [number, number]));
/** North for `legM`, then back south 30 m to the east (both legs within 100 m of each other). */
const outAndBack = (legM: number) =>
  course([
    ...Array.from({ length: legM / 100 + 1 }, (_, i) => [0, i * 100] as [number, number]),
    ...Array.from({ length: legM / 100 + 1 }, (_, i) => [30, legM - i * 100] as [number, number]),
  ]);

const SPEED = 1000 / 300; // 5:00 /km
const T0 = 1_000_000;

/** Folds fixes the way the projection does: the first one starts progress at 0. */
function run(c: Course, fixes: ProgressFix[], from: CourseProgress | null = null): CourseProgress[] {
  const out: CourseProgress[] = [];
  let state = from;
  for (const fix of fixes) {
    state = advanceProgress(c, state ?? startProgress(fix.recordedAt), fix);
    out.push(state);
  }
  return out;
}

/** One fix every 5 s along course distances [fromM, toM] of a straight-north layout, at 5:00 /km. */
function alongNorth(fromM: number, toM: number, t0 = T0, x = 0): ProgressFix[] {
  const fixes: ProgressFix[] = [];
  for (let t = 0; fromM + t * SPEED <= toM; t += 5) fixes.push({ ...at(x, fromM + t * SPEED), recordedAt: t0 + t * 1000 });
  return fixes;
}

const near = (actual: number, expected: number, tolerance: number, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} vs ${expected}`);

test('startProgress: 0, window clock at the fix, on course, no rejoin', () => {
  assert.deepStrictEqual(startProgress(5), { progressM: 0, skippedM: 0, lastMatchAt: 5, offCourse: false, rejoinCount: 0, rejoinM: null, rejoinAt: null });
});

test('a runner along a straight course: progress follows the distance run, never offCourse', () => {
  const c = straight(3000);
  const states = run(c, alongNorth(0, 3000));
  for (const s of states) assert.equal(s.offCourse, false);
  near(states.at(-1)!.progressM, 3000, 1);
  assert.equal(states.at(-1)!.skippedM, 0);
});

test('out-and-back outbound: a fix also within 100 m of the return leg stays on the outbound pass', () => {
  const c = outAndBack(1000); // the return leg is 30 m east of the outbound one
  const states = run(c, alongNorth(0, 900));
  for (const [i, s] of states.entries()) near(s.progressM, i * 5 * SPEED, 1, `fix ${i}`);
  // The same position read from the return leg would be 2030 − 900 = 1130.
  assert.ok(states.at(-1)!.progressM < 1000);
});

test('lap course: fixes near start = finish give progress ≈ distance run, never ≈ lengthM', () => {
  const c = course([[0, 0], [0, 200], [200, 200], [200, 0], [0, 0]]); // 800 m, all within the first window
  const fixes = alongNorth(0, 100);
  const states = run(c, fixes);
  assert.ok(states[0]!.progressM < 1, String(states[0]!.progressM));
  near(states.at(-1)!.progressM, 100, 2);
});

test('late Start at 40 % of 5 km: 5 fixes off course at 0, the 6th jumps to its position; skippedM holds the jump', () => {
  const c = straight(5000);
  const fixes = alongNorth(2000, 2500);
  const states = run(c, fixes);
  for (let i = 0; i < REJOIN_FIXES - 1; i++) {
    assert.equal(states[i]!.offCourse, true, `fix ${i}`);
    assert.equal(states[i]!.progressM, 0);
    assert.equal(states[i]!.rejoinCount, i + 1);
  }
  const jump = states[REJOIN_FIXES - 1]!;
  near(jump.progressM, 2000 + 5 * 5 * SPEED, 1, 'jump');
  assert.equal(jump.offCourse, false);
  assert.equal(jump.skippedM, jump.progressM);
  assert.equal(jump.lastMatchAt, fixes[REJOIN_FIXES - 1]!.recordedAt);
  // After the jump, progress − skippedM grows at the running speed only.
  const last = states.at(-1)!;
  near(last.progressM, 2500, 2);
  near(last.progressM - last.skippedM, ((fixes.at(-1)!.recordedAt - fixes[REJOIN_FIXES - 1]!.recordedAt) / 1000) * SPEED, 2);
});

test('scattered rejoin matches never jump', () => {
  const c = straight(5000);
  const fixes: ProgressFix[] = Array.from({ length: 12 }, (_, i) => ({ ...at(0, i % 2 === 0 ? 2000 : 4000), recordedAt: T0 + i * 5000 }));
  const states = run(c, fixes);
  for (const s of states) {
    assert.equal(s.progressM, 0);
    assert.equal(s.offCourse, true);
    assert.ok(s.rejoinCount < REJOIN_FIXES);
  }
});

test('a fix far from any part of the course ahead resets the rejoin count', () => {
  const c = straight(5000);
  const fixes = alongNorth(2000, 2050);
  const counted = run(c, fixes);
  assert.equal(counted.at(-1)!.rejoinCount, fixes.length);
  const reset = run(c, [{ ...at(500, 2100), recordedAt: fixes.at(-1)!.recordedAt + 5000 }], counted.at(-1)!);
  assert.equal(reset[0]!.rejoinCount, 0);
  assert.equal(reset[0]!.offCourse, true);
});

test('2 km gap: the grown window matches the pass nearest the expected position', () => {
  const c = outAndBack(1500); // 3000 m; the return leg passes 30 m east of the start area
  const before = run(c, alongNorth(0, 100));
  const p = before.at(-1)!;
  near(p.progressM, 100, 1);
  // 2050 m further after 615 s: 150 m before the finish, on the return leg next to the 150 m outbound point.
  const after = run(c, [{ ...at(30, 150), recordedAt: p.lastMatchAt + 615_000 }], p);
  near(after[0]!.progressM, 1500 + 30 + 1350, 2); // the 30 m turn counts
  assert.equal(after[0]!.offCourse, false);
});

test('detour: 100 m+ from the course is offCourse with progress unchanged; the next in-window match clears it', () => {
  const c = straight(3000);
  const states = run(c, alongNorth(0, 500));
  const p = states.at(-1)!;
  const t = p.lastMatchAt;
  const [detour] = run(c, [{ ...at(150, 520), recordedAt: t + 5000 }], p);
  assert.equal(detour!.offCourse, true);
  assert.equal(detour!.progressM, p.progressM);
  assert.equal(detour!.lastMatchAt, t);
  const [back] = run(c, [{ ...at(0, 540), recordedAt: t + 10_000 }], detour!);
  assert.equal(back!.offCourse, false);
  near(back!.progressM, 540, 1);
  assert.equal(back!.rejoinCount, 0);
});

test('progress never decreases: a fix behind progress (in the back window) keeps it', () => {
  const c = straight(3000);
  const p = run(c, alongNorth(0, 500)).at(-1)!;
  const [s] = run(c, [{ ...at(0, p.progressM - 30), recordedAt: p.lastMatchAt + 5000 }], p);
  assert.equal(s!.offCourse, false);
  assert.equal(s!.progressM, p.progressM);
});

test('matchOnCourse clips to [fromM, toM]', () => {
  const c = straight(3000);
  near(matchOnCourse(c, at(0, 500), 0, 1000, 0)!, 500, 0.5);
  assert.equal(matchOnCourse(c, at(0, 1500), 0, 1000, 0), null, 'beyond toM by more than 100 m');
  near(matchOnCourse(c, at(0, 1050), 0, 1000, 0)!, 1000, 0.5, 'clamped to toM');
  near(matchOnCourse(c, at(0, 450), 500, 1000, 0)!, 500, 0.5, 'clamped to fromM');
  assert.equal(matchOnCourse(c, at(0, 200), 400, 1000, 0), null, 'behind fromM by more than 100 m');
  near(matchOnCourse(c, at(0, 150), 150, 150, 0)!, 150, 0.5, 'zero-length window');
  assert.equal(matchOnCourse(c, at(0, 150), 200, 100, 0), null, 'empty window');
  near(matchOnCourse(c, at(0, 2990), 2500, 9999, 0)!, 2990, 0.5, 'toM past the end');
});

test('matchOnCourse: on an out-and-back, the pass nearest expectedM wins', () => {
  const c = outAndBack(1000);
  near(matchOnCourse(c, at(15, 300), 0, c.lengthM, 300)!, 300, 1);
  near(matchOnCourse(c, at(15, 300), 0, c.lengthM, 1730)!, 1000 + 30 + 700, 1);
});

test('new session after a long pause on an out-and-back: a restarted window clock stays on the outbound leg', () => {
  const c = outAndBack(1500);
  const p = run(c, alongNorth(0, 300)).at(-1)!;
  const resumeAt = p.lastMatchAt + 3_600_000; // an hour later
  const fix = { ...at(15, 310), recordedAt: resumeAt };
  // Carrying the clock across the pause would pick the return leg (expected ≈ p + 10.8 km).
  assert.ok(advanceProgress(c, p, fix).progressM > 2000);
  // The projection restarts the clock on a new session: the outbound pass wins.
  near(advanceProgress(c, { ...p, lastMatchAt: resumeAt }, fix).progressM, 310, 1);
});
