// The spectator's view mode, shared by the map and the list: "All runners"
// (selectedId null) or one selected runner that the map follows or not.
// View state only: never part of the live store, the URL or localStorage.
export type SelectionState = {
  selectedId: string | null;
  /** Always false while nothing is selected. */
  following: boolean;
};

export type SelectionListener = (state: SelectionState) => void;

export type Selection = {
  get: () => SelectionState;
  /** Selects the runner and (re)starts following, even when it is already selected. */
  select: (runnerId: string) => void;
  /** Back to the overview: clears the selection and stops following. */
  showAll: () => void;
  /** Stops following the selected runner (hand pan or zoom); no-op without a selection. */
  pauseFollow: () => void;
  /** Follows the selected runner again (Re-center); no-op without a selection. */
  resumeFollow: () => void;
  /** Called after every real change with the new state. */
  subscribe: (listener: SelectionListener) => void;
};

export function createSelection(): Selection {
  let state: SelectionState = { selectedId: null, following: false };
  const listeners: SelectionListener[] = [];

  function set(next: SelectionState): void {
    if (next.selectedId === state.selectedId && next.following === state.following) return;
    state = next;
    for (const listener of listeners) listener(state);
  }

  return {
    get: () => state,
    select(runnerId) {
      set({ selectedId: runnerId, following: true });
    },
    showAll() {
      set({ selectedId: null, following: false });
    },
    pauseFollow() {
      if (state.selectedId !== null) set({ selectedId: state.selectedId, following: false });
    },
    resumeFollow() {
      if (state.selectedId !== null) set({ selectedId: state.selectedId, following: true });
    },
    subscribe(listener) {
      listeners.push(listener);
    },
  };
}
