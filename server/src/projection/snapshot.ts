// Read-side snapshot (AD-6, AD-9). Story 1.2: every runner notStarted with an
// empty track. Story 1.5 replaces the empty views with the folded projection.
import type { EventInfo, RunnerView, Snapshot } from '@running-live-tracker/shared';
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

function notStartedView(runnerId: string): RunnerView {
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

/** The single snapshot builder behind GET /api/v1/snapshot and the SSE `snapshot` event. */
export function buildSnapshot(config: EventConfig, now: number): Snapshot {
  const runnerIds = config.runners.map((r) => r.runnerId);
  return {
    serverNow: now,
    event: buildEventInfo(config),
    runners: runnerIds.map(notStartedView),
    tracks: Object.fromEntries(runnerIds.map((id) => [id, []])),
  };
}
