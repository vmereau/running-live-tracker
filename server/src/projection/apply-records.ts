// The one fold (AD-4) shared by boot replay and the live path: a runner's stored
// in-window records, in canonical order (sessionStartedAt, sessionId, seq),
// become a RunnerView plus a track. Pure: never mutates its input state.
import type { RunnerStatus, RunnerView, TrackPoint } from '@running-live-tracker/shared';
import type { RunKey } from '../store/open-store.ts';
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

/** Folds `records` (canonical order, all after `state.lastKey`) into a new state. */
export function applyRecords(state: RunnerState, records: readonly RunRecord[]): RunnerState {
  const next: Mutable<RunnerState> = { ...state };
  const appended: TrackPoint[] = [];
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
    next.lastFixAt = record.recordedAt;
    next.lastPosition = { lat, lon };
    appended.push({ lat, lon, recordedAt: record.recordedAt });
  }
  if (appended.length > 0) next.track = [...state.track, ...appended];
  return next;
}

export function toRunnerView(state: RunnerState): RunnerView {
  return {
    ...initialRunnerView(state.runnerId),
    status: state.status,
    runStartedAt: state.runStartedAt,
    runEndedAt: state.runEndedAt,
    lastFixAt: state.lastFixAt,
    lastReceivedAt: state.lastReceivedAt,
    lastPosition: state.lastPosition === null ? null : { ...state.lastPosition },
  };
}
