// The event's shared course (Story 3.3): a polyline with cumulative haversine
// distances and its total length. Pure; built once at boot by config.
import { cumulativeDistancesM } from './geo.ts';
import type { LatLon } from './geo.ts';

export type Course = {
  points: LatLon[];
  /** Distance from the first point to each point (first entry 0, last entry lengthM). */
  cumulativeM: number[];
  lengthM: number;
};

/** Builds the course polyline. Throws on fewer than 2 points or a zero length. */
export function buildCourse(points: readonly LatLon[]): Course {
  if (points.length < 2) throw new Error(`a course needs at least 2 points, got ${points.length}`);
  const copy = points.map((p) => ({ lat: p.lat, lon: p.lon }));
  const cumulativeM = cumulativeDistancesM(copy);
  const lengthM = cumulativeM[cumulativeM.length - 1]!;
  if (!(lengthM > 0)) throw new Error('a course must have a non-zero length (all points are identical)');
  return { points: copy, cumulativeM, lengthM };
}
