// The one fold (AD-4) shared by boot replay and the live path: a runner's stored
// in-window records, in canonical order (sessionStartedAt, sessionId, seq),
// become a RunnerView plus a track. Pure: never mutates its input state.
import type { RunnerStatus, RunnerView, TrackPoint } from '@running-live-tracker/shared';
import type { RunKey } from '../store/open-store.ts';
import { avgPaceSPerKm, currentPaceSPerKm, currentPaceWindowStart, segmentDistanceM } from '../domain/stats.ts';
import type { PaceSample } from '../domain/stats.ts';
import type { Course } from '../domain/course.ts';
import { advanceProgress, startProgress } from '../domain/progress.ts';
import type { CourseProgress } from '../domain/progress.ts';
import { initialRunnerView } from './snapshot.ts';

/** Largest accuracy radius (m) a fix may have to count. 30 exactly is accepted. */
export const MAX_ACCURACY_M = 30;

/** A stored record with its session's canonical sessionStartedAt (structurally a store StoredRunRecord). */
export type RunRecord = {
  sessionStartedAt: number;
  sessionId: string;
  seq: number;
  kind: 'fix' | 'end';
  recordedAt: number;
  receivedAt: number;
  lat: number | null;
  lon: number | null;
  accuracyM: number | null;
};

export type RunnerState = {
  readonly runnerId: string;
  readonly status: RunnerStatus;
  readonly runStartedAt: number | null;
  readonly runEndedAt: number | null;
  readonly lastFixAt: number | null;
  readonly lastReceivedAt: number | null;
  readonly lastPosition: { lat: number; lon: number } | null;
  readonly track: readonly TrackPoint[];
  /** Sum of the segments between consecutive accepted fixes (sessions and gaps included). */
  readonly distanceM: number;
  /** Progress along the course: null without a course or before the first accepted fix. */
  readonly progress: CourseProgress | null;
  /** sessionId of the last accepted fix: a new session restarts the progress window clock. */
  readonly lastFixSessionId: string | null;
  /** Accepted fixes from the current-pace window start on (older ones are never needed again). */
  readonly paceSamples: readonly PaceSample[];
  /** Canonical key of the last folded record (ignored ones included), or null before any. */
  readonly lastKey: RunKey | null;
  /** True once the session of `lastKey` has folded its `end`: its later records are ignored. */
  readonly sessionEnded: boolean;
};

export function initialRunnerState(runnerId: string): RunnerState {
  return {
    runnerId,
    status: 'notStarted',
    runStartedAt: null,
    runEndedAt: null,
    lastFixAt: null,
    lastReceivedAt: null,
    lastPosition: null,
    track: [],
    distanceM: 0,
    progress: null,
    lastFixSessionId: null,
    paceSamples: [],
    lastKey: null,
    sessionEnded: false,
  };
}

/** Compares two canonical keys: negative if a sorts first, 0 if equal, positive otherwise. */
export function compareRunKeys(a: RunKey, b: RunKey): number {
  if (a.sessionStartedAt !== b.sessionStartedAt) return a.sessionStartedAt < b.sessionStartedAt ? -1 : 1;
  if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
  return a.seq === b.seq ? 0 : a.seq < b.seq ? -1 : 1;
}

/** fix ∧ accuracyM ≤ 30 ∧ recordedAt > lastFixAt (always true before the first accepted fix). */
export function isAccepted(state: Pick<RunnerState, 'lastFixAt'>, record: RunRecord): boolean {
  return (
    record.kind === 'fix' &&
    record.accuracyM !== null &&
    record.accuracyM <= MAX_ACCURACY_M &&
    record.lat !== null &&
    record.lon !== null &&
    (state.lastFixAt === null || record.recordedAt > state.lastFixAt)
  );
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Folds `records` (canonical order, all after `state.lastKey`) into a new state.
 * With a course, accepted fixes also move the course progress, and the pace samples
 * measure progress minus the distance skipped by rejoin jumps.
 */
export function applyRecords(state: RunnerState, records: readonly RunRecord[], course: Course | null = null): RunnerState {
  const next: Mutable<RunnerState> = { ...state };
  const appended: TrackPoint[] = [];
  const appendedSamples: PaceSample[] = [];
  for (const record of records) {
    const sameSession = next.lastKey !== null && next.lastKey.sessionId === record.sessionId;
    const ended = sameSession && next.sessionEnded;
    next.lastKey = { sessionStartedAt: record.sessionStartedAt, sessionId: record.sessionId, seq: record.seq };
    next.sessionEnded = ended;
    if (ended) continue; // after its session's end: ignored completely

    next.lastReceivedAt = next.lastReceivedAt === null ? record.receivedAt : Math.max(next.lastReceivedAt, record.receivedAt);

    if (record.kind === 'end') {
      next.sessionEnded = true;
      if (next.status === 'active') {
        next.status = 'stopped';
        next.runEndedAt = record.recordedAt;
      }
      continue;
    }

    if (!isAccepted(next, record)) continue;
    const lat = record.lat!;
    const lon = record.lon!;
    if (next.status === 'notStarted') next.runStartedAt = record.recordedAt;
    next.status = 'active';
    next.runEndedAt = null;
    if (next.lastPosition !== null) next.distanceM += segmentDistanceM(next.lastPosition, { lat, lon });
    if (course !== null) {
      const first = next.progress === null;
      let progress = next.progress ?? startProgress(record.recordedAt);
      // A new session (Stop then resume): the pause is not movement, so the window clock
      // restarts and a rejoin begun before the pause is dropped.
      if (next.lastFixSessionId !== null && next.lastFixSessionId !== record.sessionId) {
        progress = { ...progress, lastMatchAt: record.recordedAt, rejoinCount: 0, rejoinM: null, rejoinAt: null };
      }
      progress = advanceProgress(course, progress, { lat, lon, recordedAt: record.recordedAt });
      // Tracking began where the first fix matched: the metres before it were never run.
      if (first) progress = { ...progress, skippedM: progress.skippedM + progress.progressM };
      next.progress = progress;
    }
    next.lastFixSessionId = record.sessionId;
    next.lastFixAt = record.recordedAt;
    appendedSamples.push({ recordedAt: record.recordedAt, distanceM: paceDistanceM(next) });
    next.lastPosition = { lat, lon };
    appended.push({ lat, lon, recordedAt: record.recordedAt });
  }
  if (appended.length > 0) next.track = [...state.track, ...appended];
  if (appendedSamples.length > 0) {
    const samples = [...state.paceSamples, ...appendedSamples];
    next.paceSamples = samples.slice(Math.max(0, currentPaceWindowStart(samples)));
  }
  return next;
}

/** The distance paces are measured on: progress minus skipped metres with a course, else the raw distance. */
function paceDistanceM(state: Pick<RunnerState, 'progress' | 'distanceM'>): number {
  return state.progress === null ? state.distanceM : state.progress.progressM - state.progress.skippedM;
}

export function toRunnerView(state: RunnerState, course: Course | null = null): RunnerView {
  const elapsedS = state.runStartedAt === null || state.lastFixAt === null ? 0 : (state.lastFixAt - state.runStartedAt) / 1000;
  const progress = course === null ? null : state.progress;
  const paceM = course === null ? state.distanceM : paceDistanceM(state);
  return {
    ...initialRunnerView(state.runnerId),
    status: state.status,
    runStartedAt: state.runStartedAt,
    runEndedAt: state.runEndedAt,
    lastFixAt: state.lastFixAt,
    lastReceivedAt: state.lastReceivedAt,
    lastPosition: state.lastPosition === null ? null : { ...state.lastPosition },
    distanceM: course === null ? state.distanceM : (progress?.progressM ?? 0),
    progressM: progress?.progressM ?? null,
    remainingM: progress === null ? null : Math.max(0, course!.lengthM - progress.progressM),
    progressFraction: progress === null ? null : Math.min(1, progress.progressM / course!.lengthM),
    offCourse: progress?.offCourse ?? false,
    avgPaceSPerKm: avgPaceSPerKm(elapsedS, paceM),
    currentPaceSPerKm: state.status === 'stopped' ? null : currentPaceSPerKm(state.paceSamples),
  };
}
