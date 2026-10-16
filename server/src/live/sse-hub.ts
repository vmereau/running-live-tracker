// SSE hub (AD-6): one hijacked response per viewer. On attach it writes the
// headers and a fresh `snapshot`, then a `: ping` comment every interval.
// publish() broadcasts projection changes: `track` (appended points) then `runner`,
// or a fresh `snapshot` when a runner's track was rebuilt instead of extended.
import type { ServerResponse } from 'node:http';
import type { RunnerEvent, Snapshot, TrackEvent } from '@running-live-tracker/shared';
import type { RunnerChange } from '../projection/create-projection.ts';

export const DEFAULT_PING_INTERVAL_MS = 20_000;

export type LiveHubOptions = {
  getSnapshot: () => Snapshot;
  /** Server clock, epoch ms, stamped as serverNow on `track` and `runner` payloads. */
  now: () => number;
  pingIntervalMs?: number;
};

export type LiveHub = {
  /** Takes over a raw response: writes SSE headers and the snapshot, then keeps it alive until the client leaves. */
  attach: (res: ServerResponse) => void;
  /** Broadcasts one projection change to every open stream. */
  publish: (change: RunnerChange) => void;
  /** Ends every open stream (server shutdown). */
  closeAll: () => void;
  clientCount: () => number;
};

type Client = { res: ServerResponse; timer: NodeJS.Timeout };

function frame(event: 'snapshot' | 'runner' | 'track', data: Snapshot | RunnerEvent | TrackEvent): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createLiveHub({ getSnapshot, now, pingIntervalMs = DEFAULT_PING_INTERVAL_MS }: LiveHubOptions): LiveHub {
  const clients = new Set<Client>();

  // A dead socket must never throw into a timer or a request handler.
  function write(res: ServerResponse, chunk: string): void {
    if (res.destroyed || res.writableEnded) return;
    try {
      res.write(chunk);
    } catch {
      // swallowed: the 'close' handler cleans the client up
    }
  }

  function remove(client: Client): void {
    clearInterval(client.timer);
    clients.delete(client);
  }

  function attach(res: ServerResponse): void {
    res.on('error', () => {});
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    write(res, `event: snapshot\ndata: ${JSON.stringify(getSnapshot())}\n\n`);

    const timer = setInterval(() => write(res, ': ping\n\n'), pingIntervalMs);
    timer.unref();
    const client: Client = { res, timer };
    clients.add(client);
    res.on('close', () => remove(client));
  }

  function publish(change: RunnerChange): void {
    if (clients.size === 0) return;
    let chunk: string;
    if (change.trackReset) {
      chunk = frame('snapshot', getSnapshot());
    } else {
      const serverNow = now();
      chunk = '';
      if (change.appendedPoints.length > 0) {
        chunk += frame('track', { serverNow, runnerId: change.runnerId, points: change.appendedPoints });
      }
      chunk += frame('runner', { serverNow, view: change.view });
    }
    for (const client of clients) write(client.res, chunk);
  }

  function closeAll(): void {
    for (const client of [...clients]) {
      remove(client);
      if (!client.res.writableEnded) client.res.end();
    }
  }

  return { attach, publish, closeAll, clientCount: () => clients.size };
}
