import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineM } from './geo.ts';
import {
  CURRENT_PACE_MIN_WINDOW_M,
  CURRENT_PACE_MIN_WINDOW_S,
  MIN_AVG_PACE_DISTANCE_M,
  avgPaceSPerKm,
  currentPaceSPerKm,
  currentPaceWindowStart,
  segmentDistanceM,
} from './stats.ts';
import type { PaceSample } from './stats.ts';

const s = (seconds: number, distanceM: number): PaceSample => ({ recordedAt: 1_000_000 + seconds * 1000, distanceM });

test('thresholds are the named values', () => {
  assert.equal(MIN_AVG_PACE_DISTANCE_M, 100);
  assert.equal(CURRENT_PACE_MIN_WINDOW_S, 60);
  assert.equal(CURRENT_PACE_MIN_WINDOW_M, 200);
});

test('segmentDistanceM is the haversine distance', () => {
  const a = { lat: 48.85, lon: 2.35 };
  const b = { lat: 48.86, lon: 2.3 };
  assert.equal(segmentDistanceM(a, b), haversineM(a, b));
  assert.equal(segmentDistanceM(a, a), 0);
});

test('avgPaceSPerKm: elapsed / km, null below 100 m and for non-positive elapsed time', () => {
  assert.equal(avgPaceSPerKm(30, 100), 300);
  assert.equal(avgPaceSPerKm(30, 99.999), null);
  assert.equal(avgPaceSPerKm(900, 3000), 300);
  assert.equal(avgPaceSPerKm(0, 3000), null);
  assert.equal(avgPaceSPerKm(-5, 3000), null);
  assert.equal(avgPaceSPerKm(Number.NaN, 3000), null);
  assert.equal(avgPaceSPerKm(30, Number.NaN), null);
});

test('currentPaceSPerKm: null without data or with a single sample', () => {
  assert.equal(currentPaceSPerKm([]), null);
  assert.equal(currentPaceSPerKm([s(0, 0)]), null);
  assert.equal(currentPaceWindowStart([]), -1);
});

test('currentPaceSPerKm: exactly 60 s and 200 m is enough', () => {
  assert.equal(currentPaceSPerKm([s(0, 0), s(60, 200)]), 300);
});

test('currentPaceSPerKm: null until both the time and the distance spans are reached', () => {
  assert.equal(currentPaceSPerKm([s(0, 0), s(50, 300)]), null, '300 m in 50 s');
  assert.equal(currentPaceSPerKm([s(0, 0), s(90, 150)]), null, '150 m in 90 s');
  assert.equal(currentPaceSPerKm([s(0, 0), s(59.999, 200)]), null);
  assert.equal(currentPaceSPerKm([s(0, 0), s(60, 199.999)]), null);
});

test('currentPaceSPerKm: uses the shortest trailing window that qualifies', () => {
  // Slow at first (600 s/km), then 300 s/km: only the latest qualifying start counts.
  const samples = [s(0, 0), s(60, 100), s(120, 200), s(150, 300), s(180, 400)];
  assert.equal(currentPaceWindowStart(samples), 2);
  assert.equal(currentPaceSPerKm(samples), 300);
  // The time span alone is not enough: the window must also cover 200 m.
  const slowEnd = [s(0, 0), s(100, 400), s(170, 450), s(200, 500)];
  // Index 1 spans 100 s but only 100 m, so the window reaches back to index 0.
  assert.equal(currentPaceWindowStart(slowEnd), 0);
  assert.equal(currentPaceSPerKm(slowEnd), 200 / 0.5);
});

test('currentPaceSPerKm: dropping samples before the window start does not change the result', () => {
  const samples = [s(0, 0), s(60, 100), s(120, 200), s(150, 300), s(180, 400)];
  const start = currentPaceWindowStart(samples);
  assert.equal(currentPaceSPerKm(samples.slice(start)), currentPaceSPerKm(samples));
});
