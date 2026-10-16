import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IngestBatch } from '@running-live-tracker/shared';
import type { IngestRecord } from '@running-live-tracker/shared';
import { EARTH_RADIUS_M } from '../src/domain/geo.ts';
import {
  MAX_BACKOFF_MS,
  UsageError,
  backoffMs,
  parseDurationMs,
  parseGap,
  parsePace,
  parseSimArgs,
  planRun,
  simulate,
} from './simulate-runner.ts';
import type { SimDeps, SimOptions } from './simulate-runner.ts';

const scriptPath = join(import.meta.dirname, 'simulate-runner.ts');
const ONE_DEGREE_M = (EARTH_RADIUS_M * Math.PI) / 180;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A straight line north from (0, 0), `lengthM` long, with intermediate points every ~100 m. */
function lineNorth(lengthM: number, altitude = false) {
  const n = Math.max(1, Math.round(lengthM / 100));
  return Array.from({ length: n + 1 }, (_, i) => {
    const p = { lat: ((lengthM * i) / n) / ONE_DEGREE_M, lon: 0 };
    return altitude ? { ...p, altitudeM: 100 + i } : p;
  });
}

// ---------------------------------------------------------------- parsing

test('parseDurationMs accepts s/m/h suffixes and bare seconds', () => {
  assert.equal(parseDurationMs('30s'), 30_000);
  assert.equal(parseDurationMs('5m'), 300_000);
  assert.equal(parseDurationMs('1.5h'), 5_400_000);
  assert.equal(parseDurationMs('45'), 45_000);
  assert.equal(parseDurationMs('0'), 0);
  for (const bad of ['', 'abc', '-5s', '5d', '1m30s']) assert.throws(() => parseDurationMs(bad), UsageError, bad);
});

test('parsePace reads min:ss per km', () => {
  assert.equal(parsePace('5:00'), 300);
  assert.equal(parsePace('4:35'), 275);
  assert.equal(parsePace('12:05'), 725);
  for (const bad of ['5', '5:60', '0:00', 'a:bc', '5:5']) assert.throws(() => parsePace(bad), UsageError, bad);
});

test('parseGap reads [i:]<at>+<duration>', () => {
  assert.deepEqual(parseGap('2m+1m', 2), { atMs: 120_000, durationMs: 60_000 });
  assert.deepEqual(parseGap('1:120s+30s', 2), { runner: 1, atMs: 120_000, durationMs: 30_000 });
  for (const bad of ['2m', '2:2m+1m', '2m+0s', 'x+1m', '+1m']) assert.throws(() => parseGap(bad, 2), UsageError, bad);
});

test('parseSimArgs: defaults, repeated keys and gaps, pace list repeating its last value', () => {
  const base = ['--base-url', 'https://example.ts.net/', '--gpx', 'a.gpx'];
  assert.deepStrictEqual(parseSimArgs([...base, '--key', 'k1']), {
    baseUrl: 'https://example.ts.net',
    gpxPath: 'a.gpx',
    keys: ['k1'],
    paceSPerKm: [300],
    timeScale: 1,
    staggerMs: 0,
    gaps: [],
  } satisfies SimOptions);
  const opts = parseSimArgs([
    '--',
    ...base,
    '--key', 'k1', '--key=k2', '--key', 'k3',
    '--pace', '4:30,5:15',
    '--time-scale', '60',
    '--stagger', '30s',
    '--gap', '2m+1m',
    '--gap', '2:10m+30s',
  ]);
  assert.deepStrictEqual(opts.keys, ['k1', 'k2', 'k3']);
  assert.deepStrictEqual(opts.paceSPerKm, [270, 315, 315]);
  assert.equal(opts.timeScale, 60);
  assert.equal(opts.staggerMs, 30_000);
  assert.deepStrictEqual(opts.gaps, [
    { atMs: 120_000, durationMs: 60_000 },
    { runner: 2, atMs: 600_000, durationMs: 30_000 },
  ]);
});

for (const [name, args] of [
  ['no base url', ['--gpx', 'a.gpx', '--key', 'k']],
  ['bad base url', ['--base-url', 'nope', '--gpx', 'a.gpx', '--key', 'k']],
  ['ftp base url', ['--base-url', 'ftp://x', '--gpx', 'a.gpx', '--key', 'k']],
  ['no gpx', ['--base-url', 'http://x', '--key', 'k']],
  ['no key', ['--base-url', 'http://x', '--gpx', 'a.gpx']],
  ['unknown option', ['--base-url', 'http://x', '--gpx', 'a.gpx', '--key', 'k', '--speed', '3']],
  ['positional', ['--base-url', 'http://x', '--gpx', 'a.gpx', '--key', 'k', 'extra']],
  ['zero time scale', ['--base-url', 'http://x', '--gpx', 'a.gpx', '--key', 'k', '--time-scale', '0']],
  ['gap for a missing runner', ['--base-url', 'http://x', '--gpx', 'a.gpx', '--key', 'k', '--gap', '1:1m+1m']],
] as const) {
  test(`parseSimArgs rejects ${name}`, () => {
    assert.throws(() => parseSimArgs(args), UsageError);
  });
}

// ---------------------------------------------------------------- plan

test('planRun: 1 km at 5:00/km is 61 fixes 5 s apart, from the first point to the last', () => {
  const points = lineNorth(1000);
  const plan = planRun(points, 300);
  assert.ok(Math.abs(plan.lengthM - 1000) < 1e-6);
  assert.equal(plan.speedMps, 1000 / 300);
  assert.equal(plan.finishMs, 300_000);
  assert.equal(plan.fixes.length, 61);
  plan.fixes.forEach((f, i) => assert.equal(f.atMs, i * 5_000));
  assert.deepEqual(plan.fixes[0], { atMs: 0, lat: 0, lon: 0 });
  assert.deepEqual(plan.fixes[60], { atMs: 300_000, ...points.at(-1)! });
  // Halfway in time is halfway along the line.
  assert.ok(Math.abs(plan.fixes[30]!.lat * ONE_DEGREE_M - 500) < 1e-6);
  assert.ok(plan.fixes.every((f) => !('altitudeM' in f)));
});

test('planRun adds a fix at the finish when it is off the 5 s grid, and carries altitude', () => {
  const plan = planRun(lineNorth(1010, true), 300); // 303 s
  assert.equal(plan.finishMs, 303_000);
  assert.equal(plan.fixes.length, 62);
  assert.equal(plan.fixes.at(-2)!.atMs, 300_000);
  assert.equal(plan.fixes.at(-1)!.atMs, 303_000);
  assert.ok(plan.fixes.every((f) => typeof f.altitudeM === 'number'));
  assert.equal(plan.fixes[0]!.altitudeM, 100);
  assert.equal(plan.fixes.at(-1)!.altitudeM, 110);
});

test('planRun on a single point is one fix at t = 0; on no point it throws', () => {
  const plan = planRun([{ lat: 1, lon: 2 }], 300);
  assert.equal(plan.finishMs, 0);
  assert.deepEqual(plan.fixes, [{ atMs: 0, lat: 1, lon: 2 }]);
  assert.throws(() => planRun([], 300), /no track or route points/);
});

test('backoffMs doubles from 1 s and caps at 60 s', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 20].map(backoffMs), [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  assert.equal(MAX_BACKOFF_MS, 60_000);
});

// ---------------------------------------------------------------- simulation against a stub server

/** Virtual clock: sleep() resolves in time order, one timer at a time, without real waiting. */
function virtualClock(start = 1_767_225_600_000) {
  let now = start;
  let id = 0;
  let scheduled = false;
  const timers: { at: number; id: number; resolve: () => void }[] = [];
  const sleeps: number[] = [];
  const pump = () => {
    scheduled = false;
    timers.sort((a, b) => a.at - b.at || a.id - b.id);
    const next = timers.shift();
    if (next === undefined) return;
    now = Math.max(now, next.at);
    next.resolve();
    schedule();
  };
  const schedule = () => {
    if (!scheduled && timers.length > 0) {
      scheduled = true;
      setImmediate(pump);
    }
  };
  return {
    now: () => now,
    sleeps,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        sleeps.push(ms);
        timers.push({ at: now + ms, id: id++, resolve });
        schedule();
      }),
  };
}

type Post = { at: number; authorization: string | undefined; batch: IngestBatch };
/** 'ack' stores and acks the whole batch, `ackThrough` only up to that seq; `status`/`body` is sent as is (nothing stored). */
type Reply = { status: number; body: unknown } | 'ack' | { ackThrough: number };

/** node:http stub of the ingest endpoint. `respond` decides each reply ('ack' acks the whole batch). */
async function stubServer(clock: { now: () => number }, respond: (post: Post, index: number) => Reply = () => 'ack') {
  const posts: Post[] = [];
  const stored = new Map<string, Map<number, IngestRecord>>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/api/v1/ingest');
      assert.equal(req.headers['content-type'], 'application/json');
      const batch = IngestBatch.parse(JSON.parse(body));
      const post = { at: clock.now(), authorization: req.headers.authorization, batch };
      posts.push(post);
      const reply = respond(post, posts.length - 1);
      res.setHeader('content-type', 'application/json');
      if (reply === 'ack' || 'ackThrough' in reply) {
        const through = reply === 'ack' ? batch.records.at(-1)!.seq : reply.ackThrough;
        const session = stored.get(batch.sessionId) ?? new Map<number, IngestRecord>();
        stored.set(batch.sessionId, session);
        for (const r of batch.records.filter((x) => x.seq <= through)) {
          assert.ok(!session.has(r.seq), `seq ${r.seq} posted again after it was acked`);
          session.set(r.seq, r);
        }
        res.end(JSON.stringify({ sessionId: batch.sessionId, ackedThroughSeq: through, serverNow: clock.now() }));
      } else {
        res.statusCode = reply.status;
        res.end(JSON.stringify(reply.body));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    posts,
    stored,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

const KEY = 'k'.repeat(43);

async function run(
  stub: Awaited<ReturnType<typeof stubServer>>,
  clock: ReturnType<typeof virtualClock>,
  overrides: Partial<SimOptions> & { points: { lat: number; lon: number; altitudeM?: number }[] },
  fetchImpl: typeof fetch = fetch,
) {
  const lines: string[] = [];
  const deps: SimDeps = { now: clock.now, sleep: clock.sleep, fetch: fetchImpl, log: (l) => lines.push(l) };
  const result = await simulate(
    { baseUrl: stub.baseUrl, gpxPath: 'x.gpx', keys: [KEY], paceSPerKm: [300], timeScale: 1, staggerMs: 0, gaps: [], ...overrides },
    deps,
  );
  for (const line of lines) assert.ok(!line.includes(KEY), `log line leaks the key: ${line}`);
  return { result, lines };
}

function assertComplete(records: Map<number, IngestRecord> | undefined, count: number) {
  assert.ok(records !== undefined);
  const seqs = [...records.keys()].sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: count }, (_, i) => i));
  assert.equal(records.get(count - 1)!.kind, 'end');
  for (let i = 0; i < count - 1; i++) assert.equal(records.get(i)!.kind, 'fix');
}

test('normal run: every fix posted as recorded, acked, then end; one session', async () => {
  const clock = virtualClock();
  const stub = await stubServer(clock);
  try {
    const startedAt = clock.now();
    const { result, lines } = await run(stub, clock, { points: lineNorth(200, true) }); // 60 s: 13 fixes + end
    assert.equal(result.allAcked, true);
    assert.equal(result.runners.length, 1);
    const r = result.runners[0]!;
    assert.match(r.sessionId, UUID_V4);
    assert.equal(r.sessionStartedAt, startedAt);
    assert.equal(r.recordCount, 14);
    assert.equal(r.droppedCount, 0);

    assert.equal(stub.stored.size, 1);
    const records = stub.stored.get(r.sessionId);
    assertComplete(records, 14);
    for (let i = 0; i < 13; i++) {
      const fix = records!.get(i)!;
      assert.ok(fix.kind === 'fix');
      assert.equal(fix.recordedAt, startedAt + i * 5_000);
      assert.equal(fix.accuracyM, 5);
      assert.equal(fix.speedMps, 1000 / 300);
      assert.equal(typeof fix.altitudeM, 'number');
    }
    assert.equal(records!.get(13)!.recordedAt, startedAt + 60_000);
    for (const p of stub.posts) {
      assert.equal(p.authorization, `Bearer ${KEY}`);
      assert.equal(p.batch.sessionId, r.sessionId);
      assert.equal(p.batch.sessionStartedAt, startedAt);
    }
    // Online the whole time: each fix goes out right after it is recorded.
    assert.equal(stub.posts.length, 13);
    assert.deepEqual(stub.posts.at(-1)!.batch.records.map((x) => x.seq), [12, 13]);
    assert.ok(lines.some((l) => l.includes('done: all 14 records acked')));
  } finally {
    await stub.close();
  }
});

test('no altitude in the GPX: fixes have no altitudeM', async () => {
  const clock = virtualClock();
  const stub = await stubServer(clock);
  try {
    const { result } = await run(stub, clock, { points: lineNorth(50) });
    const records = [...stub.stored.get(result.runners[0]!.sessionId)!.values()];
    assert.ok(records.every((r) => !('altitudeM' in r)));
  } finally {
    await stub.close();
  }
});

test('offline gap: fixes keep being recorded, nothing is posted during the gap, backlog goes oldest first', async () => {
  const clock = virtualClock();
  const stub = await stubServer(clock);
  try {
    const startedAt = clock.now();
    const { result } = await run(stub, clock, { points: lineNorth(1000), gaps: [{ atMs: 120_000, durationMs: 60_000 }] });
    assert.equal(result.allAcked, true);
    assertComplete(stub.stored.get(result.runners[0]!.sessionId), 62);
    for (const p of stub.posts) {
      const t = p.at - startedAt;
      assert.ok(t < 120_000 || t >= 180_000, `posted at ${t} ms, inside the gap`);
    }
    const firstAfter = stub.posts.find((p) => p.at - startedAt >= 180_000)!;
    // Fixes 24..35 (120 s .. 175 s) were held, plus fix 36 recorded at 180 s.
    assert.deepEqual(firstAfter.batch.records.map((x) => x.seq), Array.from({ length: 13 }, (_, i) => 24 + i));
    const seqs = stub.posts.flatMap((p) => p.batch.records.map((x) => x.seq));
    assert.deepEqual(seqs, Array.from({ length: 62 }, (_, i) => i), 'each record posted once, in order');
  } finally {
    await stub.close();
  }
});

test('gap past the finish: backlog over 200 records goes in chunks of at most 200, then end', async () => {
  const clock = virtualClock();
  const stub = await stubServer(clock);
  try {
    const startedAt = clock.now();
    // 2 km at 10:00/km = 1200 s: 241 fixes + end. Offline from 10 s until long after the finish.
    const { result } = await run(stub, clock, {
      points: lineNorth(2000),
      paceSPerKm: [600],
      gaps: [{ atMs: 10_000, durationMs: 3_600_000 }],
    });
    assert.equal(result.allAcked, true);
    assertComplete(stub.stored.get(result.runners[0]!.sessionId), 242);
    const sizes = stub.posts.map((p) => p.batch.records.length);
    assert.deepEqual(sizes, [1, 1, 200, 40]);
    // The gap ends at the finish: the backlog is posted then, not an hour later.
    assert.equal(stub.posts[2]!.at - startedAt, 1_200_000);
    assert.equal(stub.posts[3]!.batch.records.at(-1)!.kind, 'end');
  } finally {
    await stub.close();
  }
});

test('server errors and network errors: retried with backoff 1 s, 2 s, 4 s, no record lost or duplicated', async () => {
  const clock = virtualClock();
  const stub = await stubServer(clock, (_post, i) =>
    i < 2 ? { status: 503, body: { error: { code: 'UNAVAILABLE', message: 'down' } } } : 'ack',
  );
  let calls = 0;
  const flakyFetch: typeof fetch = async (input, init) => {
    calls++;
    if (calls === 3) throw new TypeError('fetch failed');
    return fetch(input, init);
  };
  try {
    const startedAt = clock.now();
    const { result, lines } = await run(stub, clock, { points: lineNorth(100) }, flakyFetch); // 30 s: 7 fixes + end
    assert.equal(result.allAcked, true);
    assertComplete(stub.stored.get(result.runners[0]!.sessionId), 8);
    // 503 at t=0, 503 at t=1 s, network error at t=3 s, success at t=7 s.
    assert.deepEqual(stub.posts.slice(0, 3).map((p) => p.at - startedAt), [0, 1_000, 7_000]);
    assert.deepEqual(stub.posts[2]!.batch.records.map((x) => x.seq), [0, 1]);
    assert.ok(lines.some((l) => l.includes('HTTP 503 UNAVAILABLE')));
    assert.ok(lines.some((l) => l.includes('network error')));
    assert.ok(lines.some((l) => l.includes('retry 3 in 4 s')));
  } finally {
    await stub.close();
  }
});

for (const status of [401, 429, 500]) {
  test(`HTTP ${status} is retried`, async () => {
    const clock = virtualClock();
    const stub = await stubServer(clock, (_post, i) => (i === 0 ? { status, body: { error: { code: 'X', message: 'x' } } } : 'ack'));
    try {
      const { result } = await run(stub, clock, { points: lineNorth(20) });
      assert.equal(result.allAcked, true);
      assertComplete(stub.stored.get(result.runners[0]!.sessionId), result.runners[0]!.recordCount);
    } finally {
      await stub.close();
    }
  });
}

for (const [status, code] of [[400, 'INVALID_BATCH'], [409, 'SESSION_OWNER_MISMATCH'], [413, 'BATCH_TOO_LARGE']] as const) {
  test(`HTTP ${status}: the batch is dropped and logged, later records are still sent`, async () => {
    const clock = virtualClock();
    const stub = await stubServer(clock, (post) =>
      post.batch.records.some((r) => r.seq === 3) ? { status, body: { error: { code, message: 'no' } } } : 'ack',
    );
    try {
      const { result, lines } = await run(stub, clock, { points: lineNorth(100) }); // 7 fixes + end
      assert.equal(result.allAcked, false);
      assert.equal(result.runners[0]!.droppedCount, 1);
      const seqs = [...stub.stored.get(result.runners[0]!.sessionId)!.keys()].sort((a, b) => a - b);
      assert.deepEqual(seqs, [0, 1, 2, 4, 5, 6, 7]);
      assert.equal(stub.posts.filter((p) => p.batch.records.some((r) => r.seq === 3)).length, 1, 'not resent');
      assert.ok(lines.some((l) => l.includes(`rejected with HTTP ${status} ${code}, dropped`)));
    } finally {
      await stub.close();
    }
  });
}

for (const [name, body] of [
  ['a body that is not an IngestAck', () => ({ ok: true })],
  ['an ack for another session', () => ({ sessionId: randomUUID(), ackedThroughSeq: 0, serverNow: 1 })],
] as const) {
  test(`HTTP 200 with ${name}: retried with backoff, nothing removed, nothing lost`, async () => {
    const clock = virtualClock();
    const stub = await stubServer(clock, (_post, i) => (i === 0 ? { status: 200, body: body() } : 'ack'));
    try {
      const startedAt = clock.now();
      const { result, lines } = await run(stub, clock, { points: lineNorth(100) }); // 7 fixes + end
      assert.equal(result.allAcked, true);
      assertComplete(stub.stored.get(result.runners[0]!.sessionId), 8);
      assert.equal(stub.posts[1]!.at - startedAt, 1_000);
      assert.deepEqual(stub.posts[1]!.batch.records.map((x) => x.seq), [0], 'seq 0 kept and resent');
      assert.ok(lines.some((l) => l.includes('unexpected ack')));
    } finally {
      await stub.close();
    }
  });
}

test('partial ack: only the acked records are removed, the rest are resent right away', async () => {
  const clock = virtualClock();
  // Offline for the first 20 s, so seqs 0..4 go out as one batch when the gap ends; ack only through seq 1.
  const stub = await stubServer(clock, (_post, i) => (i === 0 ? { ackThrough: 1 } : 'ack'));
  try {
    const startedAt = clock.now();
    const { result } = await run(stub, clock, { points: lineNorth(100), gaps: [{ atMs: 0, durationMs: 20_000 }] });
    assert.equal(result.allAcked, true);
    assertComplete(stub.stored.get(result.runners[0]!.sessionId), 8);
    assert.deepEqual(stub.posts[0]!.batch.records.map((x) => x.seq), [0, 1, 2, 3, 4]);
    assert.deepEqual(stub.posts[1]!.batch.records.map((x) => x.seq), [2, 3, 4]);
    assert.equal(stub.posts[1]!.at - startedAt, 20_000, 'no backoff after a valid ack');
  } finally {
    await stub.close();
  }
});

test('several runners: one session each, paces in key order, stagger and per-runner gaps', async () => {
  const clock = virtualClock();
  const stub = await stubServer(clock);
  const keys = ['a'.repeat(43), 'b'.repeat(43)];
  try {
    const lines: string[] = [];
    // Post times taken when the client sends (the server-side time can run ahead while other runners' timers fire).
    const sent: { authorization: string; at: number }[] = [];
    const recordingFetch: typeof fetch = async (input, init) => {
      sent.push({ authorization: new Headers(init?.headers).get('authorization')!, at: clock.now() });
      return fetch(input, init);
    };
    const result = await simulate(
      {
        baseUrl: stub.baseUrl,
        gpxPath: 'x.gpx',
        keys,
        paceSPerKm: [300, 240],
        timeScale: 10,
        staggerMs: 30_000,
        gaps: [{ runner: 1, atMs: 20_000, durationMs: 30_000 }],
        points: lineNorth(200),
      },
      { now: clock.now, sleep: clock.sleep, fetch: recordingFetch, log: (l) => lines.push(l) },
    );
    assert.equal(result.allAcked, true);
    const [r0, r1] = result.runners;
    assert.notEqual(r0!.sessionId, r1!.sessionId);
    // Stagger is simulated time, divided by the time scale on the wall clock.
    assert.equal(r1!.sessionStartedAt - r0!.sessionStartedAt, 3_000);
    // 200 m: 60 s (13 fixes + end) at 5:00, 48 s (11 fixes incl. finish + end) at 4:00.
    assertComplete(stub.stored.get(r0!.sessionId), 14);
    assertComplete(stub.stored.get(r1!.sessionId), 12);
    const fix1 = stub.stored.get(r1!.sessionId)!.get(1)!;
    assert.ok(fix1.kind === 'fix');
    assert.equal(fix1.speedMps, 1000 / 240);
    // recordedAt follows simulated time even though the wall clock ran 10x faster.
    assert.equal(fix1.recordedAt, r1!.sessionStartedAt + 5_000);
    for (const p of stub.posts) {
      assert.equal(p.batch.sessionId, (p.authorization === `Bearer ${keys[0]}` ? r0! : r1!).sessionId);
    }
    const r1Posts = sent.filter((s) => s.authorization === `Bearer ${keys[1]}`);
    assert.ok(r1Posts.length > 0);
    for (const s of r1Posts) {
      const simT = (s.at - r1!.sessionStartedAt) * 10;
      assert.ok(simT < 20_000 || simT >= 48_000, `runner 1 posted at ${simT} ms of run time, inside its gap`);
    }
    for (const line of lines) for (const k of keys) assert.ok(!line.includes(k));
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------- CLI

test('simulate CLI: usage errors exit 1 with the usage text', () => {
  const res = spawnSync(process.execPath, [scriptPath, '--gpx', 'x.gpx'], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Missing --base-url/);
  assert.match(res.stderr, /Usage: pnpm simulate/);
});

test('simulate CLI: an unreadable GPX exits 1', () => {
  const res = spawnSync(
    process.execPath,
    [scriptPath, '--base-url', 'http://127.0.0.1:9', '--gpx', join(import.meta.dirname, 'missing.gpx'), '--key', 'secret-key'],
    { encoding: 'utf8' },
  );
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Cannot read GPX/);
  assert.ok(!res.stderr.includes('secret-key') && !res.stdout.includes('secret-key'));
});

test('simulate CLI: exits 1 and says so when a batch is dropped', { timeout: 20_000 }, async () => {
  const stub = await stubServer({ now: Date.now }, () => ({ status: 400, body: { error: { code: 'INVALID_BATCH', message: 'no' } } }));
  const gpx = join(mkdtempSync(join(tmpdir(), 'rlt-sim-gpx-')), 'short.gpx');
  writeFileSync(gpx, '<gpx><trk><trkseg><trkpt lat="0" lon="0"/><trkpt lat="0.0002" lon="0"/></trkseg></trk></gpx>');
  const child = spawn(process.execPath, [scriptPath, '--base-url', stub.baseUrl, '--gpx', gpx, '--key', KEY, '--time-scale', '1000'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (out += c));
    const [code] = (await once(child, 'exit')) as [number | null];
    assert.equal(code, 1, out);
    assert.match(out, /some records were dropped/);
    assert.ok(stub.posts.length > 0);
  } finally {
    child.kill();
    await stub.close();
  }
});

test('simulate CLI: a GPX with no points exits 1', () => {
  const gpx = join(mkdtempSync(join(tmpdir(), 'rlt-sim-gpx-')), 'empty.gpx');
  writeFileSync(gpx, '<gpx><wpt lat="1" lon="2"/></gpx>');
  const res = spawnSync(process.execPath, [scriptPath, '--base-url', 'http://127.0.0.1:9', '--gpx', gpx, '--key', KEY], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /has no track or route points/);
});
