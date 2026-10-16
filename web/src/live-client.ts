// Feeds the store from the live SSE stream (AD-6). The browser reconnects by
// itself after a dropped connection; the server then sends a fresh snapshot,
// which replaces the old state. If the source gives up (CLOSED, e.g. a 502
// while the PC is down) a new one is created after a short delay.
import type { RunnerEvent, Snapshot, TrackEvent } from '@running-live-tracker/shared';
import type { Store } from './store.ts';

const LIVE_URL = '/api/v1/live';
const RECREATE_DELAY_MS = 3_000;

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting';

function parse<T>(e: Event): T | null {
  try {
    return JSON.parse((e as MessageEvent<string>).data) as T;
  } catch {
    return null;
  }
}

export function connectLive(store: Store, onStatus: (status: ConnectionStatus) => void): void {
  let everOpened = false;

  function open(): void {
    const source = new EventSource(LIVE_URL);
    onStatus(everOpened ? 'reconnecting' : 'connecting');

    source.addEventListener('open', () => {
      everOpened = true;
      onStatus('open');
    });
    source.addEventListener('error', () => {
      onStatus(everOpened ? 'reconnecting' : 'connecting');
      if (source.readyState === EventSource.CLOSED) {
        source.close();
        setTimeout(open, RECREATE_DELAY_MS);
      }
    });
    source.addEventListener('snapshot', (e) => {
      const snapshot = parse<Snapshot>(e);
      if (snapshot) store.applySnapshot(snapshot);
    });
    source.addEventListener('runner', (e) => {
      const event = parse<RunnerEvent>(e);
      if (event) store.applyRunner(event);
    });
    source.addEventListener('track', (e) => {
      const event = parse<TrackEvent>(e);
      if (event) store.applyTrack(event);
    });
  }

  open();
}
