import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { EventEmitter, once } from 'node:events';
import type { ServerResponse } from 'node:http';
import { Snapshot } from '@running-live-tracker/shared';
import { createLiveHub } from './sse-hub.ts';
import type { LiveHub } from './sse-hub.ts';

const snapshot: Snapshot = {
  serverNow: 1_760_000_000_000,
  event: { eventId: 'e', name: 'E', hasCourse: false, lengthM: null, runners: [] },
  runners: [],
  tracks: {},
};

async function serve(hub: LiveHub): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => hub.attach(res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${port}/` };
}

/** Reads the stream until `predicate(text)` holds, or fails after `timeoutMs`. */
async function readUntil(body: ReadableStream<Uint8Array>, predicate: (text: string) => boolean, timeoutMs = 2_000) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let done = false;
  const deadline = setTimeout(() => void reader.cancel(), timeoutMs);
  try {
    while (!predicate(text)) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        break;
      }
      const value = chunk.value;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    clearTimeout(deadline);
  }
  return { text, done, reader };
}

async function waitFor(cond: () => boolean, timeoutMs = 2_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('attach writes SSE headers, the snapshot first, then pings', async () => {
  const hub = createLiveHub({ getSnapshot: () => snapshot, pingIntervalMs: 30 });
  const { server, url } = await serve(hub);
  try {
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform');
    assert.equal(res.headers.get('content-encoding'), null);
    const { text, reader } = await readUntil(res.body!, (t) => t.split(': ping\n\n').length > 2);
    const first = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
    assert.ok(text.startsWith(first), text);
    Snapshot.parse(JSON.parse(first.split('\n')[1]!.slice('data: '.length)));
    assert.match(text.slice(first.length), /^(: ping\n\n){2,}$/);
    await reader.cancel();
  } finally {
    hub.closeAll();
    server.close();
  }
});

test('client abort clears the client and its timer', async () => {
  const hub = createLiveHub({ getSnapshot: () => snapshot, pingIntervalMs: 20 });
  const { server, url } = await serve(hub);
  try {
    const controller = new AbortController();
    const res = await fetch(url, { signal: controller.signal });
    await readUntil(res.body!, (t) => t.includes('event: snapshot'));
    assert.equal(hub.clientCount(), 1);
    controller.abort();
    await waitFor(() => hub.clientCount() === 0);
    // Pings keep firing for no one; give them a few intervals to prove nothing throws.
    await new Promise((r) => setTimeout(r, 80));
  } finally {
    hub.closeAll();
    server.close();
  }
});

test('closeAll ends every open stream', async () => {
  const hub = createLiveHub({ getSnapshot: () => snapshot, pingIntervalMs: 60_000 });
  const { server, url } = await serve(hub);
  try {
    const bodies = await Promise.all([fetch(url), fetch(url)]);
    await waitFor(() => hub.clientCount() === 2);
    hub.closeAll();
    assert.equal(hub.clientCount(), 0);
    for (const res of bodies) {
      const started = Date.now();
      const { text, done } = await readUntil(res.body!, () => false);
      // A cancel at the 2 s deadline would also report done, so check it ended promptly.
      assert.ok(done && Date.now() - started < 1_000, 'stream should end promptly');
      assert.ok(text.startsWith('event: snapshot'));
    }
  } finally {
    server.close();
  }
});

test('default ping interval is 20 s', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const writes: string[] = [];
    const fake = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      writeHead: () => fake,
      write: (chunk: string) => writes.push(chunk) > 0,
      end: () => fake,
    });
    const hub = createLiveHub({ getSnapshot: () => snapshot });
    hub.attach(fake as unknown as ServerResponse);
    const pings = () => writes.filter((w) => w === ': ping\n\n').length;
    assert.ok(writes[0]!.startsWith('event: snapshot'));
    mock.timers.tick(19_999);
    assert.equal(pings(), 0);
    mock.timers.tick(1);
    assert.equal(pings(), 1);
    hub.closeAll();
  } finally {
    mock.timers.reset();
  }
});
