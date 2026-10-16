// In-memory live projection (AD-4, AD-6). Rebuilt from the fix log at boot by
// replaying applyRecords; kept current by ingest calling recordsCommitted after
// each committed batch; the single emitter of runner changes. Derived values
// live only here and are never persisted.
import { isDeepStrictEqual } from 'node:util';
import type { RunnerView, Snapshot, TrackPoint } from '@running-live-tracker/shared';
import type { EventConfig } from '../config/load-config.ts';
import type { Store } from '../store/open-store.ts';
import { applyRecords, compareRunKeys, initialRunnerState, toRunnerView } from './apply-records.ts';
import type { RunnerState } from './apply-records.ts';
import { buildSnapshot } from './snapshot.ts';
import type { ProjectedRunner } from './snapshot.ts';

/** What ingest reports after a batch commits. firstInsertedSeq is null when every record was already stored. */
export type RecordsCommitted = { runnerId: string; sessionId: string; firstInsertedSeq: number | null };

export type RunnerChange = {
  runnerId: string;
  view: RunnerView;
  /** Points added at the end of the runner's track (empty when none, or on a reset). */
  appendedPoints: TrackPoint[];
  /** True when the new track is not the old one plus a suffix: clients need a fresh snapshot. */
  trackReset: boolean;
};

export type ChangeListener = (change: RunnerChange) => void;

export type Projection = {
  /** Folds what a committed batch made visible and emits a change if the runner's view or track moved. */
  recordsCommitted(committed: RecordsCommitted): void;
  snapshot(now: number): Snapshot;
  /** Registers the single change listener (the SSE hub). */
  onChange(listener: ChangeListener): void;
};

export type CreateProjectionOptions = {
  config: EventConfig;
  store: Pick<Store, 'readSession' | 'readRunRecords'>;
};

function isPrefix(prefix: readonly TrackPoint[], track: readonly TrackPoint[]): boolean {
  if (prefix.length > track.length) return false;
  for (let i = 0; i < prefix.length; i++) if (!isDeepStrictEqual(prefix[i], track[i])) return false;
  return true;
}

export function createProjection({ config, store }: CreateProjectionOptions): Projection {
  const { opensAt, closesAt } = config;
  const states = new Map<string, RunnerState>();
  const views = new Map<string, RunnerView>();
  let listener: ChangeListener | undefined;

  const replay = (runnerId: string): RunnerState =>
    applyRecords(initialRunnerState(runnerId), store.readRunRecords(runnerId, opensAt, closesAt));

  // Boot replay: the same fold the live path uses.
  for (const { runnerId } of config.runners) {
    const state = replay(runnerId);
    states.set(runnerId, state);
    views.set(runnerId, toRunnerView(state));
  }

  function recordsCommitted({ runnerId, sessionId, firstInsertedSeq }: RecordsCommitted): void {
    const prev = states.get(runnerId);
    if (prev === undefined) return; // not a configured runner

    // Fast path unless the batch inserted a record at or before the last folded key.
    let refold = false;
    if (firstInsertedSeq !== null && prev.lastKey !== null) {
      const session = store.readSession(sessionId);
      if (session !== undefined && session.sessionStartedAt >= opensAt && session.sessionStartedAt <= closesAt) {
        const key = { sessionStartedAt: session.sessionStartedAt, sessionId, seq: firstInsertedSeq };
        refold = compareRunKeys(key, prev.lastKey) <= 0;
      }
    }
    const next = refold
      ? replay(runnerId)
      : applyRecords(prev, store.readRunRecords(runnerId, opensAt, closesAt, prev.lastKey ?? undefined));
    states.set(runnerId, next);

    const prevView = views.get(runnerId)!;
    const view = toRunnerView(next);
    views.set(runnerId, view);

    // The fast path only ever appends; a refold may rebuild the track from scratch.
    const trackReset = refold && !isPrefix(prev.track, next.track);
    const appendedPoints = trackReset ? [] : next.track.slice(prev.track.length);
    if (!trackReset && appendedPoints.length === 0 && isDeepStrictEqual(prevView, view)) return;
    listener?.({ runnerId, view, appendedPoints, trackReset });
  }

  function snapshot(now: number): Snapshot {
    const projected = new Map<string, ProjectedRunner>();
    for (const [runnerId, state] of states) projected.set(runnerId, { view: views.get(runnerId)!, track: state.track });
    return buildSnapshot(config, now, projected);
  }

  function onChange(next: ChangeListener): void {
    if (listener !== undefined) throw new Error('projection already has a change listener');
    listener = next;
  }

  return { recordsCommitted, snapshot, onChange };
}
