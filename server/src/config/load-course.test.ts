import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from './load-config.ts';
import { loadCourse } from './load-course.ts';

const dir = mkdtempSync(join(tmpdir(), 'rlt-course-'));
const configPath = join(dir, 'event.json');
const lapPath = join(import.meta.dirname, '..', '..', '..', 'shared', 'fixtures', 'gpx', 'lap.gpx');
mkdirSync(join(dir, 'courses'));
writeFileSync(join(dir, 'courses', 'race.gpx'), readFileSync(lapPath, 'utf8'));

const wrap = (body: string) => `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>${body}</trkseg></trk></gpx>`;
let n = 0;
function writeGpx(body: string): string {
  const name = `c-${n++}.gpx`;
  writeFileSync(join(dir, name), wrap(body));
  return name;
}

function assertConfigError(coursePath: string, ...fragments: string[]) {
  assert.throws(
    () => loadCourse(configPath, coursePath),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError, `expected ConfigError, got ${String(err)}`);
      for (const f of fragments) assert.ok(err.message.includes(f), `message should contain "${f}":\n${err.message}`);
      return true;
    },
  );
}

test('resolves coursePath relative to the directory of event.json', () => {
  const course = loadCourse(configPath, 'courses/race.gpx');
  assert.ok(course.lengthM > 0);
  assert.equal(course.cumulativeM.at(-1), course.lengthM);
});

test('uses an absolute coursePath as is', () => {
  const course = loadCourse(configPath, lapPath);
  assert.deepStrictEqual(course, loadCourse(configPath, 'courses/race.gpx'));
});

test('missing file: ConfigError naming the resolved path', () => {
  assertConfigError('courses/missing.gpx', 'Cannot read course GPX', join(dir, 'courses', 'missing.gpx'));
});

test('bad point: ConfigError naming the path and the point', () => {
  const name = writeGpx('<trkpt lat="1" lon="2"/><trkpt lat="abc" lon="2"/>');
  assertConfigError(name, join(dir, name), 'trkpt #2', 'not a number');
});

test('one point: ConfigError', () => {
  const name = writeGpx('<trkpt lat="1" lon="2"/>');
  assertConfigError(name, join(dir, name), 'at least 2 points');
});

test('no points at all: ConfigError', () => {
  const name = writeGpx('');
  assertConfigError(name, join(dir, name), 'at least 2 points, got 0');
});

test('identical points: ConfigError', () => {
  const name = writeGpx('<trkpt lat="1" lon="2"/><trkpt lat="1" lon="2"/>');
  assertConfigError(name, join(dir, name), 'non-zero length');
});
