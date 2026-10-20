import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCourse } from './course.ts';
import { haversineM } from './geo.ts';
import { parseGpx } from './gpx.ts';

const gpxDir = join(import.meta.dirname, '..', '..', '..', 'shared', 'fixtures', 'gpx');
const fixtures = readdirSync(gpxDir).filter((f) => f.endsWith('.gpx'));

test('there are GPX fixtures to test on', () => {
  assert.ok(fixtures.length > 0);
});

for (const file of fixtures) {
  test(`buildCourse on ${file}: positive length, last cumulative = lengthM, one entry per point`, () => {
    const points = parseGpx(readFileSync(join(gpxDir, file), 'utf8'));
    const course = buildCourse(points);
    assert.ok(course.lengthM > 0);
    assert.equal(course.points.length, points.length);
    assert.equal(course.cumulativeM.length, points.length);
    assert.equal(course.cumulativeM[0], 0);
    assert.equal(course.cumulativeM.at(-1), course.lengthM);
    for (let i = 1; i < course.cumulativeM.length; i++) assert.ok(course.cumulativeM[i]! >= course.cumulativeM[i - 1]!);
  });
}

test('buildCourse: lengthM is the haversine length; points keep lat/lon only', () => {
  const a = { lat: 48.85, lon: 2.35, altitudeM: 30 };
  const b = { lat: 48.86, lon: 2.36 };
  const course = buildCourse([a, b]);
  assert.equal(course.lengthM, haversineM(a, b));
  assert.deepStrictEqual(course.points, [{ lat: 48.85, lon: 2.35 }, { lat: 48.86, lon: 2.36 }]);
});

test('buildCourse throws on fewer than 2 points', () => {
  assert.throws(() => buildCourse([]), /at least 2 points, got 0/);
  assert.throws(() => buildCourse([{ lat: 1, lon: 2 }]), /at least 2 points, got 1/);
});

test('buildCourse throws on a zero length (identical points)', () => {
  const p = { lat: 1, lon: 2 };
  assert.throws(() => buildCourse([p, p, { ...p }]), /non-zero length/);
});
