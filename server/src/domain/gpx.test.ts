import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cumulativeDistancesM, haversineM } from './geo.ts';
import { parseGpx } from './gpx.ts';

const gpxDir = join(import.meta.dirname, '..', '..', '..', 'shared', 'fixtures', 'gpx');
const fixture = (name: string) => parseGpx(readFileSync(join(gpxDir, name), 'utf8'));
const wrap = (body: string) => `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">${body}</gpx>`;

test('multi-segment track: points of every trkseg of the first trk, in order; later trks ignored', () => {
  const points = parseGpx(
    wrap(`
      <trk><name>first</name>
        <trkseg>
          <trkpt lat="1" lon="2"><ele>100.5</ele><time>2026-01-01T00:00:00Z</time></trkpt>
          <trkpt lon="2.1" lat="1.1"/>
        </trkseg>
        <trkseg>
          <trkpt lat='1.2' lon='2.2'><ele> 99 </ele></trkpt>
          <trkpt
            lon = "2.3"
            lat = '-1.3' />
        </trkseg>
      </trk>
      <trk><trkseg><trkpt lat="50" lon="50"/></trkseg></trk>
      <rte><rtept lat="60" lon="60"/></rte>`),
  );
  assert.deepStrictEqual(points, [
    { lat: 1, lon: 2, altitudeM: 100.5 },
    { lat: 1.1, lon: 2.1 },
    { lat: 1.2, lon: 2.2, altitudeM: 99 },
    { lat: -1.3, lon: 2.3 },
  ]);
});

test('route only: the rtepts of the first rte', () => {
  const points = parseGpx(
    wrap(`
      <rte><name>r</name><rtept lat="10" lon="20"><ele>5</ele></rtept><rtept lat="11" lon="21"/></rte>
      <rte><rtept lat="12" lon="22"/></rte>`),
  );
  assert.deepStrictEqual(points, [{ lat: 10, lon: 20, altitudeM: 5 }, { lat: 11, lon: 21 }]);
});

test('a first trk without points falls back to the first rte', () => {
  const points = parseGpx(wrap('<trk><trkseg/></trk><rte><rtept lat="10" lon="20"/></rte>'));
  assert.deepStrictEqual(points, [{ lat: 10, lon: 20 }]);
});

test('nothing usable: []', () => {
  assert.deepStrictEqual(parseGpx(''), []);
  assert.deepStrictEqual(parseGpx(wrap('<wpt lat="1" lon="2"/>')), []);
  assert.deepStrictEqual(parseGpx(wrap('<trk><trkseg></trkseg></trk>')), []);
  assert.deepStrictEqual(parseGpx(wrap('<!-- <trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk> -->')), []);
});

test('a non-numeric <ele> is ignored', () => {
  assert.deepStrictEqual(parseGpx(wrap('<trk><trkseg><trkpt lat="1" lon="2"><ele>high</ele></trkpt></trkseg></trk>')), [
    { lat: 1, lon: 2 },
  ]);
});

for (const [attrs, pattern] of [
  ['lat="abc" lon="2"', /trkpt #2: lat "abc" is not a number/],
  ['lat="91" lon="2"', /trkpt #2: lat 91 is out of range/],
  ['lat="-90.5" lon="2"', /trkpt #2: lat -90.5 is out of range/],
  ['lat="1" lon="180.01"', /trkpt #2: lon 180.01 is out of range/],
  ['lat="" lon="2"', /trkpt #2: lat "" is not a number/],
  ['lon="2"', /trkpt #2: missing lat/],
] as const) {
  test(`bad coordinate (${attrs}) throws naming the point`, () => {
    const xml = wrap(`<trk><trkseg><trkpt lat="1" lon="1"/><trkpt ${attrs}/></trkseg></trk>`);
    assert.throws(() => parseGpx(xml), (err: unknown) => err instanceof Error && pattern.test(err.message));
  });
}

test('a bad rtept is named as such', () => {
  assert.throws(() => parseGpx(wrap('<rte><rtept lat="1" lon="x"/></rte>')), /GPX rtept #1: lon "x" is not a number/);
});

test('fixtures: straight, out-and-back and lap parse into real-looking tracks', () => {
  const straight = fixture('straight.gpx');
  const outAndBack = fixture('out-and-back.gpx');
  const lap = fixture('lap.gpx');
  for (const [name, points, minM, maxM] of [
    ['straight', straight, 1000, 2000],
    ['out-and-back', outAndBack, 1000, 2500],
    ['lap', lap, 1000, 2000],
  ] as const) {
    assert.ok(points.length >= 24, `${name}: ${points.length} points`);
    const lengthM = cumulativeDistancesM(points).at(-1)!;
    assert.ok(lengthM > minM && lengthM < maxM, `${name}: ${lengthM} m`);
  }
  assert.ok(straight.every((p) => p.altitudeM === undefined));
  assert.ok(lap.every((p) => typeof p.altitudeM === 'number'), 'lap has <ele> on every point');
  // Out-and-back returns along the same street; the lap ends near its start.
  assert.ok(haversineM(outAndBack[0]!, outAndBack.at(-1)!) < 20);
  assert.ok(haversineM(lap[0]!, lap.at(-1)!) < 50);
  // The lap is split in two trksegs; both are read.
  const lapXml = readFileSync(join(gpxDir, 'lap.gpx'), 'utf8');
  assert.equal(lapXml.match(/<trkseg>/g)?.length, 2);
  assert.equal(lap.length, lapXml.match(/<trkpt /g)?.length);
});
