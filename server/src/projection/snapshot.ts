// Read-side snapshot (AD-6, AD-9), built from the projected runner views and tracks.
import type { EventInfo, RunnerView, Snapshot, TrackPoint } from '@running-live-tracker/shared';
import type { EventConfig } from '../config/load-config.ts';

/** Public event info, built field by field so config-only fields (keyHash, coursePath) never leak. */
export function buildEventInfo(config: EventConfig): EventInfo {
  return {
    eventId: config.eventId,
    name: config.name,
    // Story 3.3 serves /api/v1/course and fills these in.
    hasCourse: false,
    lengthM: null,
    runners: config.runners.map((r) => ({ runnerId: r.runnerId, displayName: r.displayName, color: r.color })),
  };
}

/** The view of a runner before any accepted record. Epic 3 fields keep these contract defaults. */
export function initialRunnerView(runnerId: string): RunnerView {
  return {
    runnerId,
    status: 'notStarted',
    runStartedAt: null,
    runEndedAt: null,
    lastFixAt: null,
    lastReceivedAt: null,
    lastPosition: null,
    distanceM: 0,
    progressM: null,
    remainingM: null,
    progressFraction: null,
    offCourse: false,
    avgPaceSPerKm: null,
    currentPaceSPerKm: null,
    etaAt: null,
  };
}

/** One runner's projected state as the snapshot needs it. */
export type ProjectedRunner = { view: RunnerView; track: readonly TrackPoint[] };

/**
 * The single snapshot builder behind GET /api/v1/snapshot and the SSE `snapshot` event.
 * Runners come in config order; a configured runner missing from `projected` is notStarted with an empty track.
 */
export function buildSnapshot(config: EventConfig, now: number, projected: ReadonlyMap<string, ProjectedRunner>): Snapshot {
  const runnerIds = config.runners.map((r) => r.runnerId);
  return {
    serverNow: now,
    event: buildEventInfo(config),
    runners: runnerIds.map((id) => projected.get(id)?.view ?? initialRunnerView(id)),
    tracks: Object.fromEntries(runnerIds.map((id) => [id, [...(projected.get(id)?.track ?? [])]])),
  };
}
