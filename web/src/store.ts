// The page's single source of state (AD-6). Only SSE payloads change it:
// `snapshot` replaces everything, `runner` replaces one view, `track` appends
// points. Every payload refreshes offsetMs = serverNow - local clock, so ages
// are computed against server time. Views read it and never mutate it.
import type { RunnerEvent, Snapshot, TrackEvent } from '@running-live-tracker/shared';

export type StoreState = {
  snapshot: Snapshot | null;
  offsetMs: number;
};

export type Listener = (state: StoreState) => void;

export type Store = {
  applySnapshot: (snapshot: Snapshot) => void;
  applyRunner: (event: RunnerEvent) => void;
  applyTrack: (event: TrackEvent) => void;
  getState: () => StoreState;
  /** Server-aligned clock: local clock + offsetMs. */
  now: () => number;
  /** Calls the listener after every applied change; returns an unsubscribe function. */
  subscribe: (listener: Listener) => () => void;
};

export function createStore(clock: () => number = Date.now): Store {
  let state: StoreState = { snapshot: null, offsetMs: 0 };
  const listeners = new Set<Listener>();

  function commit(snapshot: Snapshot, serverNow: number): void {
    state = { snapshot, offsetMs: serverNow - clock() };
    for (const listener of listeners) listener(state);
  }

  function applySnapshot(snapshot: Snapshot): void {
    commit(snapshot, snapshot.serverNow);
  }

  function applyRunner({ serverNow, view }: RunnerEvent): void {
    const current = state.snapshot;
    if (!current) return; // AD-6: nothing to patch before the first snapshot
    const known = current.runners.some((r) => r.runnerId === view.runnerId);
    const runners = known
      ? current.runners.map((r) => (r.runnerId === view.runnerId ? view : r))
      : [...current.runners, view];
    commit({ ...current, serverNow, runners }, serverNow);
  }

  function applyTrack({ serverNow, runnerId, points }: TrackEvent): void {
    const current = state.snapshot;
    if (!current) return;
    const existing = current.tracks[runnerId] ?? [];
    const tracks = { ...current.tracks, [runnerId]: [...existing, ...points] };
    commit({ ...current, serverNow, tracks }, serverNow);
  }

  return {
    applySnapshot,
    applyRunner,
    applyTrack,
    getState: () => state,
    now: () => clock() + state.offsetMs,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
