// Estimated finish time (Story 3.5), defined once here. Pure; the projection fills
// RunnerView.etaAt from it live and on replay. Based on average pace for now; a blend
// with the current pace may follow the test run (Epic 4), only here.
import type { RunnerStatus } from '@running-live-tracker/shared';

/** The ETA stays null until the runner has covered at least this distance (m). */
export const ETA_MIN_DISTANCE_M = 1000;

export type EtaInput = {
  readonly hasCourse: boolean;
  readonly status: RunnerStatus;
  /** The view's distance (equals progressM with a course). */
  readonly distanceM: number;
  readonly lastFixAt: number | null;
  readonly remainingM: number | null;
  readonly avgPaceSPerKm: number | null;
};

/**
 * lastFixAt + remainingM × avgPaceSPerKm / 1000, in epoch ms rounded to the millisecond
 * (the contract's timestamps are integers); null without a course,
 * unless active, below ETA_MIN_DISTANCE_M, with any input null, with a negative (or NaN)
 * remainingM, or with a pace that is not positive (zero, negative or NaN).
 */
export function etaAt(input: EtaInput): number | null {
  const { hasCourse, status, distanceM, lastFixAt, remainingM, avgPaceSPerKm } = input;
  if (!hasCourse || status !== 'active') return null;
  if (!(distanceM >= ETA_MIN_DISTANCE_M)) return null;
  if (lastFixAt === null || remainingM === null || avgPaceSPerKm === null) return null;
  if (!(remainingM >= 0) || !(avgPaceSPerKm > 0)) return null;
  // remainingM × s/km / 1000 m/km × 1000 ms/s = remainingM × avgPaceSPerKm ms.
  return lastFixAt + Math.round(remainingM * avgPaceSPerKm);
}
