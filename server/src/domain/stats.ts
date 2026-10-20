// Race stats (Story 3.1): distance and pace, each defined once here. Pure; the
// projection folds them live and on replay. Thresholds may be tuned after the test
// run (Epic 4), only here.
import { haversineM } from './geo.ts';
import type { LatLon } from './geo.ts';

/** Average pace stays null until the runner has covered at least this distance (m). */
export const MIN_AVG_PACE_DISTANCE_M = 100;
/** The current-pace window spans at least this long (s)... */
export const CURRENT_PACE_MIN_WINDOW_S = 60;
/** ...and at least this distance (m). */
export const CURRENT_PACE_MIN_WINDOW_M = 200;

/** One accepted fix as seen by the current pace: its time and the cumulative distance at it. */
export type PaceSample = { readonly recordedAt: number; readonly distanceM: number };

/** Distance (m) added by moving from one accepted fix to the next: the straight haversine segment. */
export function segmentDistanceM(a: LatLon, b: LatLon): number {
  return haversineM(a, b);
}

/** elapsedS / (distanceM / 1000); null below MIN_AVG_PACE_DISTANCE_M or for non-positive time. */
export function avgPaceSPerKm(elapsedS: number, distanceM: number): number | null {
  if (!(distanceM >= MIN_AVG_PACE_DISTANCE_M) || !(elapsedS > 0)) return null;
  return elapsedS / (distanceM / 1000);
}

/**
 * Index of the latest sample that starts a window ending at the last sample and
 * spanning at least CURRENT_PACE_MIN_WINDOW_S and CURRENT_PACE_MIN_WINDOW_M; -1 if none.
 * Samples are in recordedAt order with non-decreasing distanceM, so both spans only
 * grow as the index decreases: the walk back stops at the first match. Later windows
 * never start earlier, so samples before this index can be dropped.
 */
export function currentPaceWindowStart(samples: readonly PaceSample[]): number {
  const last = samples[samples.length - 1];
  if (last === undefined) return -1;
  for (let i = samples.length - 2; i >= 0; i--) {
    const s = samples[i]!;
    if (last.recordedAt - s.recordedAt >= CURRENT_PACE_MIN_WINDOW_S * 1000 && last.distanceM - s.distanceM >= CURRENT_PACE_MIN_WINDOW_M) return i;
  }
  return -1;
}

/** Pace (s/km) over the shortest trailing window of at least 60 s and 200 m; null until one exists. */
export function currentPaceSPerKm(samples: readonly PaceSample[]): number | null {
  const start = currentPaceWindowStart(samples);
  if (start < 0) return null;
  const first = samples[start]!;
  const last = samples[samples.length - 1]!;
  const dtS = (last.recordedAt - first.recordedAt) / 1000;
  const dM = last.distanceM - first.distanceM;
  if (!(dtS > 0) || !(dM > 0)) return null;
  return dtS / (dM / 1000);
}
