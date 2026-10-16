import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { EventEmitter, once } from 'node:events';
import type { ServerResponse } from 'node:http';
import { RunnerEvent, Snapshot, TrackEvent } from '@running-live-tracker/shared';
import type { RunnerView } from '@running-live-tracker/shared';
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
  const hub = createLiveHub({ getSnapshot: () => snapshot, now: () => 0, pingIntervalMs: 30 });
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
  const hub = createLiveHub({ getSnapshot: () => snapshot, now: () => 0, pingIntervalMs: 20 });
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
  const hub = createLiveHub({ getSnapshot: () => snapshot, now: () => 0, pingIntervalMs: 60_000 });
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
    const hub = createLiveHub({ getSnapshot: () => snapshot, now: () => 0 });
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

// ---- Story 1.5: publish ----

function fakeResponse() {
  const writes: string[] = [];
  const fake = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writeHead: () => fake,
    write: (chunk: string) => writes.push(chunk) > 0,
    end: () => {
      fake.writableEnded = true;
      return fake;
    },
  });
  return { fake, res: fake as unknown as ServerResponse, writes };
}

/** Splits written SSE text into [event, parsed data] pairs, pings dropped. */
function frames(text: string): [string, unknown][] {
  return text
    .split('\n\n')
    .filter((f) => f !== '' && !f.startsWith(':'))
    .map((f) => {
      const [event, data] = f.split('\n');
      return [event!.slice('event: '.length), JSON.parse(data!.slice('data: '.length))];
    });
}

const view: RunnerView = {
  runnerId: 'alice',
  status: 'active',
  runStartedAt: 1_000,
  runEndedAt: null,
  lastFixAt: 2_000,
  lastReceivedAt: 3_000,
  lastPosition: { lat: 48.1, lon: 2.1 },
  distanceM: 0,
  progressM: null,
  remainingM: null,
  progressFraction: null,
  offCourse: false,
  avgPaceSPerKm: null,
  currentPaceSPerKm: null,
  etaAt: null,
};
const points = [
  { lat: 48, lon: 2, recordedAt: 1_000 },
  { lat: 48.1, lon: 2.1, recordedAt: 2_000 },
];

test('publish writes track then runner, both stamped with serverNow, to every client', () => {
  let clock = 1_760_000_000_500;
  const hub = createLiveHub({ getSnapshot: () => snapshot, now: () => clock++, pingIntervalMs: 60_000 });
  const a = fakeResponse();
  const b = fakeResponse();
  hub.attach(a.res);
  hub.attach(b.res);
  hub.publish({ runnerId: 'alice', view, appendedPoints: points, trackReset: false });
  for (const { writes } of [a, b]) {
    const got = frames(writes.join(''));
    assert.deepStrictEqual(got.map(([e]) => e), ['snapshot', 'track', 'runner']);
    assert.deepStrictEqual(TrackEvent.parse(got[1]![1]), { serverNow: 1_760_000_000_500, runnerId: 'alice', points });
    assert.deepStrictEqual(RunnerEvent.parse(got[2]![1]), { serverNow: 1_760_000_000_500, view });
  }
  hub.closeAll();
});

test('publish without appended points writes the runner frame only', () => {
  const hub = createLiveHub({ getSnapshot: () => snapshot, now: () => 7, pingIntervalMs: 60_000 });
  const a = fakeResponse();
  hub.attach(a.res);
  hub.publish({ runnerId: 'alice', view, appendedPoints: [], trackReset: false });
  assert.deepStrictEqual(frames(a.writes.join('')).slice(1), [['runner', { serverNow: 7, view }]]);
  hub.closeAll();
});

test('publish on a track reset sends a fresh snapshot instead of track/runner', () => {
  let calls = 0;
  const fresh = { ...snapshot, serverNow: 99 };
  const hub = createLiveHub({ getSnapshot: () => (calls++ === 0 ? snapshot : fresh), now: () => 7, pingIntervalMs: 60_000 });
  const a = fakeResponse();
  hub.attach(a.res);
  hub.publish({ runnerId: 'alice', view, appendedPoints: points, trackReset: true });
  assert.deepStrictEqual(frames(a.writes.join('')), [
    ['snapshot', snapshot],
    ['snapshot', fresh],
  ]);
  hub.closeAll();
});

test('publish skips dead clients and never throws', () => {
  const hub = createLiveHub({ getSnapshot: () => snapshot, now: () => 7, pingIntervalMs: 60_000 });
  const dead = fakeResponse();
  const throwing = fakeResponse();
  const alive = fakeResponse();
  for (const c of [dead, throwing, alive]) hub.attach(c.res);
  dead.fake.destroyed = true;
  throwing.fake.write = () => {
    throw new Error('EPIPE');
  };
  hub.publish({ runnerId: 'alice', view, appendedPoints: points, trackReset: false });
  assert.equal(dead.writes.length, 1, 'only the snapshot');
  assert.deepStrictEqual(frames(alive.writes.join('')).map(([e]) => e), ['snapshot', 'track', 'runner']);
  hub.closeAll();
});

test('publish with no clients is a no-op', () => {
  const hub = createLiveHub({
    getSnapshot: () => {
      throw new Error('not expected');
    },
    now: () => 7,
  });
  hub.publish({ runnerId: 'alice', view, appendedPoints: points, trackReset: true });
  assert.equal(hub.clientCount(), 0);
});
