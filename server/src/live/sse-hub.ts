// SSE hub (AD-6): one hijacked response per viewer. On attach it writes the
// headers and a fresh `snapshot`, then a `: ping` comment every interval.
// Story 1.5 adds the `runner` / `track` broadcast on top of the client set.
import type { ServerResponse } from 'node:http';
import type { Snapshot } from '@running-live-tracker/shared';

export const DEFAULT_PING_INTERVAL_MS = 20_000;

export type LiveHubOptions = {
  getSnapshot: () => Snapshot;
  pingIntervalMs?: number;
};

export type LiveHub = {
  /** Takes over a raw response: writes SSE headers and the snapshot, then keeps it alive until the client leaves. */
  attach: (res: ServerResponse) => void;
  /** Ends every open stream (server shutdown). */
  closeAll: () => void;
  clientCount: () => number;
};

type Client = { res: ServerResponse; timer: NodeJS.Timeout };

export function createLiveHub({ getSnapshot, pingIntervalMs = DEFAULT_PING_INTERVAL_MS }: LiveHubOptions): LiveHub {
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

  function closeAll(): void {
    for (const client of [...clients]) {
      remove(client);
      if (!client.res.writableEnded) client.res.end();
    }
  }

  return { attach, closeAll, clientCount: () => clients.size };
}
