// The runner a spectator picked out (list tap or marker tap). Shared by the
// map and the list; it is view state only, never part of the live store.
export type Selection = {
  get: () => string | null;
  /** Selects the runner, or clears the selection when it is already selected. */
  toggle: (runnerId: string) => void;
  subscribe: (listener: (runnerId: string | null) => void) => void;
};

export function createSelection(): Selection {
  let selected: string | null = null;
  const listeners: ((runnerId: string | null) => void)[] = [];
  return {
    get: () => selected,
    toggle(runnerId) {
      selected = selected === runnerId ? null : runnerId;
      for (const listener of listeners) listener(selected);
    },
    subscribe(listener) {
      listeners.push(listener);
    },
  };
}
