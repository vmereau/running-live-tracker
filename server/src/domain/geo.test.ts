import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EARTH_RADIUS_M, cumulativeDistancesM, haversineM, pointAtDistance } from './geo.ts';

const ONE_DEGREE_M = (EARTH_RADIUS_M * Math.PI) / 180; // 111 194.93 m

test('haversineM matches known distances', () => {
  assert.equal(haversineM({ lat: 0, lon: 0 }, { lat: 0, lon: 0 }), 0);
  assert.ok(Math.abs(haversineM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }) - ONE_DEGREE_M) < 1e-6);
  assert.ok(Math.abs(haversineM({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - ONE_DEGREE_M) < 1e-6);
  // Pole to pole along a meridian: half the circumference.
  assert.ok(Math.abs(haversineM({ lat: 90, lon: 0 }, { lat: -90, lon: 0 }) - Math.PI * EARTH_RADIUS_M) < 1e-6);
  // Paris (Notre-Dame) to London (Charing Cross): about 343.5 km.
  const parisLondon = haversineM({ lat: 48.8530, lon: 2.3499 }, { lat: 51.5073, lon: -0.1276 });
  assert.ok(Math.abs(parisLondon - 343_500) < 1_000, String(parisLondon));
  // Symmetric.
  const a = { lat: 48.85, lon: 2.35 };
  const b = { lat: 48.86, lon: 2.3 };
  assert.equal(haversineM(a, b), haversineM(b, a));
});

const line = [
  { lat: 0, lon: 0, altitudeM: 10 },
  { lat: 0.001, lon: 0, altitudeM: 20 },
  { lat: 0.001, lon: 0.002 },
];

test('cumulativeDistancesM starts at 0 and adds each segment', () => {
  assert.deepEqual(cumulativeDistancesM([]), []);
  assert.deepEqual(cumulativeDistancesM([{ lat: 1, lon: 1 }]), [0]);
  const c = cumulativeDistancesM(line);
  assert.equal(c.length, 3);
  assert.equal(c[0], 0);
  assert.equal(c[1], haversineM(line[0]!, line[1]!));
  assert.equal(c[2], c[1]! + haversineM(line[1]!, line[2]!));
});

test('pointAtDistance clamps to the ends', () => {
  const c = cumulativeDistancesM(line);
  assert.deepEqual(pointAtDistance(line, c, -5), { lat: 0, lon: 0, altitudeM: 10 });
  assert.deepEqual(pointAtDistance(line, c, 0), { lat: 0, lon: 0, altitudeM: 10 });
  assert.deepEqual(pointAtDistance(line, c, c[2]!), { lat: 0.001, lon: 0.002 });
  assert.deepEqual(pointAtDistance(line, c, 1e9), { lat: 0.001, lon: 0.002 });
  assert.deepEqual(pointAtDistance([{ lat: 3, lon: 4 }], [0], 100), { lat: 3, lon: 4 });
  assert.throws(() => pointAtDistance([], [], 0), /empty/);
});

test('pointAtDistance interpolates linearly within a segment', () => {
  const c = cumulativeDistancesM(line);
  const mid1 = pointAtDistance(line, c, c[1]! / 2);
  assert.ok(Math.abs(mid1.lat - 0.0005) < 1e-12);
  assert.equal(mid1.lon, 0);
  assert.ok(Math.abs(mid1.altitudeM! - 15) < 1e-9);

  // Exactly on a vertex.
  const v = pointAtDistance(line, c, c[1]!);
  assert.ok(Math.abs(v.lat - 0.001) < 1e-12 && Math.abs(v.lon) < 1e-12);

  // Second segment: only one end has an altitude, so it is carried over.
  const quarter = pointAtDistance(line, c, c[1]! + (c[2]! - c[1]!) / 4);
  assert.equal(quarter.lat, 0.001);
  assert.ok(Math.abs(quarter.lon - 0.0005) < 1e-12);
  assert.equal(quarter.altitudeM, 20);

  // No altitude anywhere: none in the result.
  const flat = [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.01 }];
  assert.ok(!('altitudeM' in pointAtDistance(flat, cumulativeDistancesM(flat), 100)));
});

test('pointAtDistance skips zero-length segments', () => {
  const pts = [{ lat: 0, lon: 0 }, { lat: 0, lon: 0 }, { lat: 0.001, lon: 0 }];
  const c = cumulativeDistancesM(pts);
  const p = pointAtDistance(pts, c, c[2]! / 2);
  assert.ok(Math.abs(p.lat - 0.0005) < 1e-12);
});
