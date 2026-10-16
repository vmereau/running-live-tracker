// Distances and positions along a polyline of lat/lon points. Pure; reused by the
// simulator (Story 1.4) and course progress (Story 3.3).

/** Mean Earth radius in metres. */
export const EARTH_RADIUS_M = 6_371_000;

export type LatLon = { lat: number; lon: number };
export type GeoPoint = LatLon & { altitudeM?: number };

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance between two points in metres (haversine). */
export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distance from the first point to each point along the polyline (first entry 0). */
export function cumulativeDistancesM(points: readonly LatLon[]): number[] {
  const out: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) total += haversineM(points[i - 1]!, points[i]!);
    out.push(total);
  }
  return out;
}

/**
 * The point `distanceM` metres along the polyline, interpolated linearly within its
 * segment and clamped to the first/last point. `cumulativeM` comes from
 * `cumulativeDistancesM(points)`. Altitude is interpolated when both segment ends have
 * one, else taken from whichever end has it, else omitted. Throws on an empty polyline.
 */
export function pointAtDistance(points: readonly GeoPoint[], cumulativeM: readonly number[], distanceM: number): GeoPoint {
  if (points.length === 0) throw new Error('pointAtDistance: empty polyline');
  if (cumulativeM.length !== points.length) throw new Error('pointAtDistance: cumulativeM length mismatch');
  const last = points.length - 1;
  if (!(distanceM > 0)) return copy(points[0]!);
  if (distanceM >= cumulativeM[last]!) return copy(points[last]!);

  // First index whose cumulative distance exceeds distanceM (binary search).
  let lo = 1;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulativeM[mid]! > distanceM) hi = mid;
    else lo = mid + 1;
  }
  const a = points[lo - 1]!;
  const b = points[lo]!;
  const start = cumulativeM[lo - 1]!;
  const length = cumulativeM[lo]! - start;
  const f = length > 0 ? (distanceM - start) / length : 0;
  const p: GeoPoint = { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
  if (a.altitudeM !== undefined && b.altitudeM !== undefined) p.altitudeM = a.altitudeM + (b.altitudeM - a.altitudeM) * f;
  else if (a.altitudeM !== undefined || b.altitudeM !== undefined) p.altitudeM = (a.altitudeM ?? b.altitudeM)!;
  return p;
}

function copy(p: GeoPoint): GeoPoint {
  return p.altitudeM === undefined ? { lat: p.lat, lon: p.lon } : { lat: p.lat, lon: p.lon, altitudeM: p.altitudeM };
}
