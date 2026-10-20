// Golden stats (Story 3.1): records simulated along the shared GPX fixtures at a
// fixed pace, folded through the one projection fold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunnerView } from '@running-live-tracker/shared';
import { cumulativeDistancesM, haversineM, pointAtDistance } from '../domain/geo.ts';
import type { GeoPoint } from '../domain/geo.ts';
import { parseGpx } from '../domain/gpx.ts';
import { applyRecords, initialRunnerState, toRunnerView } from './apply-records.ts';
import type { RunRecord } from './apply-records.ts';

const gpxDir = join(import.meta.dirname, '..', '..', '..', 'shared', 'fixtures', 'gpx');
const SESSION = '00000000-0000-4000-8000-000000000001';
const T0 = 1_000_000;
const PACE_S_PER_KM = 300; // 5:00 /km
const SPEED_MPS = 1000 / PACE_S_PER_KM;
const FIX_EVERY_S = 5;

function course(name: string): { points: GeoPoint[]; cumulative: number[]; lengthM: number } {
  const points = parseGpx(readFileSync(join(gpxDir, name), 'utf8'));
  const cumulative = cumulativeDistancesM(points);
  return { points, cumulative, lengthM: cumulative.at(-1)! };
}

/** `laps` copies of a closed course end to end (the start/end gap is crossed in a straight line). */
function looped(name: string, laps: number) {
  const { points } = course(name);
  const all = Array.from({ length: laps }, () => points).flat();
  const cumulative = cumulativeDistancesM(all);
  return { points: all, cumulative, lengthM: cumulative.at(-1)! };
}

/**
 * One fix every 5 s at the planned pace, along course distances [fromM, toM],
 * skipping fixes whose course distance falls in `skip` (a gap). Time runs from the
 * course start, so a late start begins with a non-zero clock.
 */
function simulate(c: { points: GeoPoint[]; cumulative: number[] }, fromM: number, toM: number, skip?: [number, number]): RunRecord[] {
  const records: RunRecord[] = [];
  for (let t = Math.ceil(fromM / SPEED_MPS / FIX_EVERY_S) * FIX_EVERY_S; t * SPEED_MPS <= toM; t += FIX_EVERY_S) {
    const d = t * SPEED_MPS;
    if (skip && d > skip[0] && d < skip[1]) continue;
    const p = pointAtDistance(c.points, c.cumulative, d);
    const recordedAt = T0 + t * 1000;
    records.push({ sessionStartedAt: T0, sessionId: SESSION, seq: records.length, kind: 'fix', recordedAt, receivedAt: recordedAt + 200, lat: p.lat, lon: p.lon, accuracyM: 5 });
  }
  return records;
}

const fold = (records: RunRecord[]) => RunnerView.parse(toRunnerView(applyRecords(initialRunnerState('alice'), records)));
const near = (actual: number | null, expected: number, tolerance: number, label: string) =>
  assert.ok(actual !== null && Math.abs(actual - expected) <= expected * tolerance, `${label}: ${actual} vs ${expected}`);

test('no course, out-and-back: distance within 1 % of the GPX length, both paces near the planned pace', () => {
  const c = course('out-and-back.gpx');
  const records = simulate(c, 0, c.lengthM);
  const view = fold(records);
  near(view.distanceM, c.lengthM, 0.01, 'distanceM');
  near(view.avgPaceSPerKm, PACE_S_PER_KM, 0.01, 'avgPace');
  near(view.currentPaceSPerKm, PACE_S_PER_KM, 0.02, 'currentPace');
  assert.equal(view.runStartedAt, records[0]!.recordedAt);
});

test('late Start at 40 % of straight: distance and elapsed count from the first accepted fix only', () => {
  const c = course('straight.gpx');
  const fromM = c.lengthM * 0.4;
  const records = simulate(c, fromM, c.lengthM);
  const view = fold(records);
  assert.equal(view.runStartedAt, records[0]!.recordedAt);
  // Course distance between the first and the last fix (both on the 5 s grid, so just under 60 %).
  const coveredM = ((records.at(-1)!.recordedAt - records[0]!.recordedAt) / 1000) * SPEED_MPS;
  assert.ok(coveredM > c.lengthM * 0.59);
  near(view.distanceM, coveredM, 0.01, 'distanceM');
  assert.ok(view.distanceM < coveredM + 1, 'nothing before the first fix counts');
  near(view.avgPaceSPerKm, PACE_S_PER_KM, 0.01, 'avgPace');
  near(view.currentPaceSPerKm, PACE_S_PER_KM, 0.02, 'currentPace');
});

test('2 km gap on a looped lap: distance adds the straight-line jump, paces stay finite and positive', () => {
  const c = looped('lap.gpx', 4);
  const gap: [number, number] = [1_500, 3_550];
  const records = simulate(c, 0, c.lengthM, gap);
  const view = fold(records);

  const last = records.findLastIndex((r) => r.recordedAt < T0 + (gap[1] / SPEED_MPS) * 1000);
  const before = records[last]!;
  const after = records[last + 1]!;
  const jumpM = haversineM({ lat: before.lat!, lon: before.lon! }, { lat: after.lat!, lon: after.lon! });
  const beforeM = ((before.recordedAt - T0) / 1000) * SPEED_MPS;
  const afterM = ((after.recordedAt - T0) / 1000) * SPEED_MPS;
  assert.ok(afterM - beforeM >= 2_000, 'the gap spans more than 2 km of course');
  assert.ok(jumpM < afterM - beforeM, 'the straight line is shorter than the course along a loop');
  // Everything but the gap is run along the course; the gap counts as the straight line.
  near(view.distanceM, c.lengthM - (afterM - beforeM) + jumpM, 0.01, 'distanceM');

  for (const pace of [view.avgPaceSPerKm, view.currentPaceSPerKm]) {
    assert.ok(pace !== null && Number.isFinite(pace) && pace > 0, String(pace));
  }
  // After the gap, the current pace is back at the planned pace.
  near(view.currentPaceSPerKm, PACE_S_PER_KM, 0.02, 'currentPace');
});
