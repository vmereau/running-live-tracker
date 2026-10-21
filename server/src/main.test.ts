import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CourseGeoJson, ErrorBody, IngestAck, RunnerEvent, Snapshot, TrackEvent } from '@running-live-tracker/shared';
import { loadCourse } from './config/load-course.ts';
import { generateKey } from '../scripts/keygen.ts';

const mainPath = join(import.meta.dirname, 'main.ts');
const exampleConfig = join(import.meta.dirname, '..', '..', 'config', 'event.example.json');

type EditableConfig = { opensAt: number; closesAt: number; runners: { runnerId: string; keyHash: string }[] };

type Frame = [event: string, data: unknown];

/** Opens an SSE stream and collects its named frames (pings dropped) in arrival order. */
function openLive(url: string) {
  const controller = new AbortController();
  const frames: Frame[] = [];
  let buffer = '';
  let failure: unknown;
  const reading = (async () => {
    const res = await fetch(url, { signal: controller.signal });
    const decoder = new TextDecoder();
    for await (const chunk of res.body!) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (block.startsWith(':')) continue;
        const [event, data] = block.split('\n');
        frames.push([event!.slice('event: '.length), JSON.parse(data!.slice('data: '.length))]);
      }
    }
  })().catch((err: unknown) => {
    if (!controller.signal.aborted) failure = err;
  });
  return {
    async until(predicate: (frames: Frame[]) => boolean, timeoutMs = 10_000): Promise<Frame[]> {
      const start = Date.now();
      while (!predicate(frames)) {
        if (failure !== undefined) throw failure;
        if (Date.now() - start > timeoutMs) throw new Error(`stream condition not met; got ${frames.map(([e]) => e).join(', ')}`);
        await new Promise((r) => setTimeout(r, 10));
      }
      return frames;
    },
    close() {
      controller.abort();
      return reading;
    },
  };
}

// Every boot gets its own data dir, so tests never touch <repo>/data.
function startMain(env: Record<string, string>) {
  return spawn(process.execPath, [mainPath], {
    env: { ...process.env, EVENT_CONFIG: exampleConfig, DATA_DIR: mkdtempSync(join(tmpdir(), 'rlt-data-')), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// PORT must be 1-65535, so pick a free port up front instead of using PORT=0.
async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as { port: number };
  probe.close();
  await once(probe, 'close');
  return port;
}

/** Collects the child's stdout (raw text and parsed JSON log lines) and resolves once it logs "server ready". */
function waitForReady(child: ReturnType<typeof startMain>) {
  const logs: Record<string, unknown>[] = [];
  const raw = { text: '' };
  let buffer = '';
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for "server ready"')), 10_000);
    child.on('exit', (code) => reject(new Error(`server exited early with code ${code}`)));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      raw.text += chunk;
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          logs.push(entry);
          if (entry['msg'] === 'server ready') {
            clearTimeout(timer);
            resolve();
          }
        } catch {
          // not a JSON log line
        }
      }
    });
  });
  return { ready, logs, raw };
}

test('boots with the example config and listens on 127.0.0.1 only', async () => {
  const port = await freePort();
  const child = startMain({ PORT: String(port) });
  try {
    const boot = waitForReady(child);
    await boot.ready;
    const { logs } = boot;

    const listening = logs.find((l) => String(l['msg']).startsWith('Server listening at'));
    assert.ok(listening, 'expected a "Server listening at" log line');
    assert.equal(listening['msg'], `Server listening at http://127.0.0.1:${port}`);

    const ready = logs.find((l) => l['msg'] === 'server ready');
    assert.equal(ready?.['webRoot'], join(import.meta.dirname, '..', '..', 'web', 'dist'));

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { eventId: string }).eventId, 'example');
  } finally {
    child.kill();
  }
});

test('ingest end to end: keygen key, HTTP batch twice, one copy in DATA_DIR/tracker.db under the key runner', async () => {
  const { key, keyHash } = generateKey('alice');
  const dataDir = join(mkdtempSync(join(tmpdir(), 'rlt-e2e-')), 'nested', 'data');
  const configPath = join(mkdtempSync(join(tmpdir(), 'rlt-e2e-config-')), 'event.json');
  const example = JSON.parse(readFileSync(exampleConfig, 'utf8')) as { runners: { runnerId: string; keyHash: string }[] };
  example.runners[0]!.keyHash = keyHash;
  writeFileSync(configPath, JSON.stringify(example));
  const batch = readFileSync(join(import.meta.dirname, '..', '..', 'shared', 'fixtures', 'valid', 'ingest-batch.mixed.json'), 'utf8');

  const port = await freePort();
  const child = startMain({ PORT: String(port), EVENT_CONFIG: configPath, DATA_DIR: dataDir });
  try {
    const { ready, logs, raw } = waitForReady(child);
    await ready;
    const url = `http://127.0.0.1:${port}/api/v1/ingest`;
    const post = (headers: Record<string, string>) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: batch });

    const acks = [];
    for (let i = 0; i < 2; i++) {
      const res = await post({ authorization: `Bearer ${key}` });
      assert.equal(res.status, 200);
      acks.push(IngestAck.parse(await res.json()));
    }
    assert.equal(acks[0]!.ackedThroughSeq, 3);
    assert.equal(acks[1]!.ackedThroughSeq, 3);

    const noKey = await post({});
    assert.equal(noKey.status, 401);
    assert.equal(ErrorBody.parse(await noKey.json()).error.code, 'UNAUTHORIZED');

    assert.ok(existsSync(join(dataDir, 'tracker.db')), 'DATA_DIR is created and holds tracker.db');
    const db = new Database(join(dataDir, 'tracker.db'));
    try {
      assert.deepStrictEqual(db.prepare('SELECT sessionId, runnerId FROM sessions').all(), [
        { sessionId: acks[0]!.sessionId, runnerId: 'alice' },
      ]);
      assert.deepStrictEqual(
        db.prepare('SELECT seq FROM records ORDER BY seq').all().map((r) => (r as { seq: number }).seq),
        [0, 1, 3],
      );
    } finally {
      db.close();
    }

    await new Promise((r) => setTimeout(r, 100)); // let the last log lines arrive
    const accepted = logs.filter((l) => l['msg'] === 'ingest batch accepted');
    assert.equal(accepted.length, 2);
    for (const line of accepted) {
      assert.equal(line['runnerId'], 'alice');
      assert.equal(typeof line['clockSkewMs'], 'number');
    }
    for (const secret of [key, '48.8566', '2.3522', '48.8567', '2.3524']) {
      assert.ok(!raw.text.includes(secret), `logs must not contain ${secret}`);
    }
  } finally {
    child.kill();
  }
});

const dir = mkdtempSync(join(tmpdir(), 'rlt-main-'));

async function bootToExit(configPath: string) {
  const child = startMain({ EVENT_CONFIG: configPath, PORT: String(await freePort()) });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
  child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
  const [code] = (await once(child, 'exit')) as [number | null];
  return { code, stdout, stderr };
}

test('boot aborts with exit code 1 and names the field paths on an invalid config', async () => {
  const path = join(dir, 'bad.json');
  writeFileSync(
    path,
    JSON.stringify({
      eventId: 'x',
      name: 'X',
      opensAt: 2,
      closesAt: 1,
      runners: [{ runnerId: 'a', displayName: 'A', color: 'red', keyHash: 'A'.repeat(64) }],
    }),
  );
  const res = await bootToExit(path);
  assert.equal(res.code, 1, res.stderr);
  for (const f of [path, 'closesAt', 'runners.0.color', 'runners.0.keyHash']) assert.ok(res.stderr.includes(f), res.stderr);
  assert.ok(!res.stdout.includes('server ready'));
});

test('boot aborts with exit code 1 naming the path when the config is missing', async () => {
  const path = join(dir, 'missing.json');
  const res = await bootToExit(path);
  assert.equal(res.code, 1, res.stderr);
  assert.ok(res.stderr.includes(path), res.stderr);
});

function exampleWithCourse(name: string, coursePath: string): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(exampleConfig, 'utf8')), coursePath }));
  return path;
}

test('boot aborts with exit code 1 naming the GPX path when the course is invalid', async () => {
  writeFileSync(join(dir, 'one-point.gpx'), '<gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>');
  const res = await bootToExit(exampleWithCourse('bad-course.json', 'one-point.gpx'));
  assert.equal(res.code, 1, res.stderr);
  assert.ok(res.stderr.includes(join(dir, 'one-point.gpx')), res.stderr);
  assert.ok(res.stderr.includes('at least 2 points'), res.stderr);
  assert.ok(!res.stdout.includes('server ready'));
});

test('boots with a course: EventInfo reports it and GET /api/v1/course serves it', async () => {
  const lap = join(import.meta.dirname, '..', '..', 'shared', 'fixtures', 'gpx', 'lap.gpx');
  const port = await freePort();
  const configPath = exampleWithCourse('with-course.json', lap);
  const expected = loadCourse(configPath, lap);
  const child = startMain({ PORT: String(port), EVENT_CONFIG: configPath });
  try {
    await waitForReady(child).ready;
    const snap = Snapshot.parse(await (await fetch(`http://127.0.0.1:${port}/api/v1/snapshot`)).json());
    assert.equal(snap.event.hasCourse, true);
    assert.equal(snap.event.lengthM, expected.lengthM);
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/course`);
    assert.equal(res.status, 200);
    const body = CourseGeoJson.parse(await res.json());
    assert.deepStrictEqual(body.coordinates, expected.points.map((p) => [p.lon, p.lat]));
  } finally {
    child.kill();
  }
});

for (const bad of ['abc', '0x50', '8e3', '0', '70000']) {
  test(`PORT=${bad} exits 1 with "Invalid PORT"`, async () => {
    const child = startMain({ PORT: bad });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => (stderr += c));
    const [code] = (await once(child, 'exit')) as [number | null];
    assert.equal(code, 1);
    assert.match(stderr, /Invalid PORT/);
  });
}

test('simulator end to end: a fixture GPX with an offline gap lands once, in order, under the key runner', { timeout: 30_000 }, async () => {
  const { key, keyHash } = generateKey('alice');
  const dataDir = mkdtempSync(join(tmpdir(), 'rlt-sim-'));
  const configPath = join(mkdtempSync(join(tmpdir(), 'rlt-sim-config-')), 'event.json');
  const example = JSON.parse(readFileSync(exampleConfig, 'utf8')) as EditableConfig;
  example.runners[0]!.keyHash = keyHash;
  // The simulator starts its session now: open the event window around it.
  example.opensAt = Date.now() - 3_600_000;
  example.closesAt = Date.now() + 3_600_000;
  writeFileSync(configPath, JSON.stringify(example));
  const gpx = join(import.meta.dirname, '..', '..', 'shared', 'fixtures', 'gpx', 'out-and-back.gpx');

  const port = await freePort();
  const server = startMain({ PORT: String(port), EVENT_CONFIG: configPath, DATA_DIR: dataDir });
  let sim: ReturnType<typeof spawn> | undefined;
  let live: ReturnType<typeof openLive> | undefined;
  try {
    const { ready, logs } = waitForReady(server);
    await ready;
    live = openLive(`http://127.0.0.1:${port}/api/v1/live`);
    await live.until((frames) => frames.length >= 1);
    // ~2.3 km at 3:00/km is ~410 s of run time; at 400x that is about one second.
    sim = spawn(
      process.execPath,
      [
        join(import.meta.dirname, '..', 'scripts', 'simulate-runner.ts'),
        '--base-url', `http://127.0.0.1:${port}`,
        '--gpx', gpx,
        '--key', key,
        '--pace', '3:00',
        '--time-scale', '400',
        '--gap', '1m+2m',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    sim.stdout!.setEncoding('utf8').on('data', (c: string) => (out += c));
    sim.stderr!.setEncoding('utf8').on('data', (c: string) => (out += c));
    const [code] = (await once(sim, 'exit')) as [number | null];
    assert.equal(code, 0, out);
    assert.ok(!out.includes(key), 'simulator output must not contain the key');
    assert.match(out, /every record acked/);

    // The stream carried the run live: track and runner frames, active first, stopped last.
    const frames = await live.until((f) => f.some(([e, d]) => e === 'runner' && (d as RunnerEvent).view.status === 'stopped'));
    live.close();
    const runnerFrames = frames.filter(([e]) => e === 'runner').map(([, d]) => RunnerEvent.parse(d).view);
    assert.equal(runnerFrames[0]!.status, 'active');
    assert.equal(runnerFrames.at(-1)!.status, 'stopped');
    const streamed = frames.filter(([e]) => e === 'track').flatMap(([, d]) => TrackEvent.parse(d).points);

    const snap = Snapshot.parse(await (await fetch(`http://127.0.0.1:${port}/api/v1/snapshot`)).json());
    const alice = snap.runners.find((r) => r.runnerId === 'alice')!;
    assert.equal(alice.status, 'stopped');
    assert.deepStrictEqual(snap.tracks['alice'], streamed, 'the streamed points are the full track');

    const db = new Database(join(dataDir, 'tracker.db'));
    try {
      const fixCount = (db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind = 'fix'").get() as { n: number }).n;
      assert.equal(snap.tracks['alice']!.length, fixCount, 'every simulated fix is in the track');
      const sessions = db.prepare('SELECT sessionId, runnerId FROM sessions').all() as { sessionId: string; runnerId: string }[];
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]!.runnerId, 'alice');
      const records = db
        .prepare('SELECT seq, kind FROM records WHERE sessionId = ? ORDER BY seq')
        .all(sessions[0]!.sessionId) as { seq: number; kind: string }[];
      assert.ok(records.length > 80, `${records.length} records`);
      assert.deepEqual(records.map((r) => r.seq), records.map((_, i) => i), 'contiguous seqs from 0');
      assert.equal(records.at(-1)!.kind, 'end');
      assert.ok(records.slice(0, -1).every((r) => r.kind === 'fix'));
    } finally {
      db.close();
    }

    await new Promise((r) => setTimeout(r, 100)); // let the last log lines arrive
    const accepted = logs.filter((l) => l['msg'] === 'ingest batch accepted');
    // The 2 min gap holds ~24 fixes, posted as one larger batch when it ends.
    assert.ok(accepted.some((l) => (l['recordCount'] as number) >= 20), JSON.stringify(accepted.map((l) => l['recordCount'])));
  } finally {
    void live?.close();
    sim?.kill();
    server.kill();
  }
});

test('live projection end to end: track then runner after a POST, same snapshot after a restart', { timeout: 30_000 }, async () => {
  const { key, keyHash } = generateKey('alice');
  const dataDir = mkdtempSync(join(tmpdir(), 'rlt-proj-'));
  const configPath = join(mkdtempSync(join(tmpdir(), 'rlt-proj-config-')), 'event.json');
  const example = JSON.parse(readFileSync(exampleConfig, 'utf8')) as EditableConfig;
  example.runners[0]!.keyHash = keyHash;
  // The fixture session starts at 1_760_000_000_000.
  example.opensAt = 1_759_000_000_000;
  example.closesAt = 1_761_000_000_000;
  writeFileSync(configPath, JSON.stringify(example));
  const batch = readFileSync(join(import.meta.dirname, '..', '..', 'shared', 'fixtures', 'valid', 'ingest-batch.mixed.json'), 'utf8');
  const env = { EVENT_CONFIG: configPath, DATA_DIR: dataDir };

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const getSnapshot = async () => Snapshot.parse(await (await fetch(`${base}/api/v1/snapshot`)).json());
  const first = startMain({ ...env, PORT: String(port) });
  let before: Snapshot;
  try {
    await waitForReady(first).ready;
    const live = openLive(`${base}/api/v1/live`);
    try {
      await live.until((f) => f.length >= 1);
      const res = await fetch(`${base}/api/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: batch,
      });
      assert.equal(res.status, 200);
      const frames = await live.until((f) => f.length >= 3);
      assert.deepStrictEqual(frames.map(([e]) => e), ['snapshot', 'track', 'runner']);
      const track = TrackEvent.parse(frames[1]![1]);
      assert.equal(track.runnerId, 'alice');
      assert.deepStrictEqual(track.points.map((p) => p.recordedAt), [1_760_000_000_000, 1_760_000_005_000]);
      const { view } = RunnerEvent.parse(frames[2]![1]);
      assert.equal(view.status, 'stopped');
      assert.equal(view.runStartedAt, 1_760_000_000_000);
      assert.equal(view.runEndedAt, 1_760_000_010_000);

      // A resend changes nothing and emits nothing.
      const again = await fetch(`${base}/api/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: batch,
      });
      assert.equal(again.status, 200);
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(frames.length, 3);
    } finally {
      await live.close();
    }
    before = await getSnapshot();
    assert.deepStrictEqual(before.tracks['alice']!.length, 2);
  } finally {
    first.kill();
    await once(first, 'exit');
  }

  const second = startMain({ ...env, PORT: String(port) });
  try {
    await waitForReady(second).ready;
    const after = await getSnapshot();
    assert.deepStrictEqual({ ...after, serverNow: 0 }, { ...before, serverNow: 0 });
  } finally {
    second.kill();
  }
});

const mixedBatch = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'shared', 'fixtures', 'valid', 'ingest-batch.mixed.json'), 'utf8'),
) as { sessionId: string; sessionStartedAt: number; records: { seq: number; kind: string; recordedAt: number }[] };

/** Another session shaped like the mixed fixture, its records shifted to start at `startedAt`. */
function sessionBatch(sessionId: string, startedAt: number) {
  const shift = startedAt - mixedBatch.sessionStartedAt;
  return {
    sessionId,
    sessionStartedAt: startedAt,
    records: mixedBatch.records.map((r) => ({ ...r, recordedAt: r.recordedAt + shift })),
  };
}

/** Writes an event config (example runners, alice's key hash replaced) and returns its path. */
function writeEventConfig(eventId: string, opensAt: number, closesAt: number, aliceKeyHash: string): string {
  const example = JSON.parse(readFileSync(exampleConfig, 'utf8')) as EditableConfig & { eventId: string };
  example.eventId = eventId;
  example.opensAt = opensAt;
  example.closesAt = closesAt;
  example.runners[0]!.keyHash = aliceKeyHash;
  const path = join(mkdtempSync(join(tmpdir(), `rlt-${eventId}-config-`)), 'event.json');
  writeFileSync(path, JSON.stringify(example));
  return path;
}

/** Boots main, runs `body` against its base URL, then stops it and waits for the exit. */
async function withServer(env: Record<string, string>, body: (base: string) => Promise<void>) {
  const port = await freePort();
  const child = startMain({ ...env, PORT: String(port) });
  try {
    await waitForReady(child).ready;
    await body(`http://127.0.0.1:${port}`);
  } finally {
    child.kill();
    await once(child, 'exit');
  }
}

async function postBatch(base: string, key: string, batch: unknown) {
  const res = await fetch(`${base}/api/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(batch),
  });
  assert.equal(res.status, 200, await res.text());
}

const fetchSnapshot = async (base: string) => Snapshot.parse(await (await fetch(`${base}/api/v1/snapshot`)).json());
const recordedAts = (snap: Snapshot, runnerId: string) => (snap.tracks[runnerId] ?? []).map((p) => p.recordedAt);

test('backup end to end: booting a backup copy gives the snapshot from backup time', { timeout: 30_000 }, async () => {
  const { key, keyHash } = generateKey('alice');
  const configPath = writeEventConfig('backup-e2e', 1_759_000_000_000, 1_761_000_000_000, keyHash);
  const dataDir = mkdtempSync(join(tmpdir(), 'rlt-backup-live-'));
  const later = sessionBatch('7d2e4f1a-3b5c-4d6e-8f70-9a1b2c3d4e5f', 1_760_100_000_000);
  let atBackup: Snapshot | undefined;
  let backupPath = '';

  await withServer({ EVENT_CONFIG: configPath, DATA_DIR: dataDir }, async (base) => {
    await postBatch(base, key, mixedBatch);
    atBackup = await fetchSnapshot(base);
    assert.equal(atBackup.tracks['alice']!.length, 2);
    const res = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'backup.ts')], {
      encoding: 'utf8',
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(res.status, 0, res.stderr);
    backupPath = res.stdout.trim();
    assert.ok(existsSync(backupPath), backupPath);
    // The server keeps serving and storing after the backup.
    await postBatch(base, key, later);
    assert.ok(recordedAts(await fetchSnapshot(base), 'alice').includes(later.records[0]!.recordedAt));
  });

  const restoredDir = mkdtempSync(join(tmpdir(), 'rlt-backup-restored-'));
  copyFileSync(backupPath, join(restoredDir, 'tracker.db'));
  await withServer({ EVENT_CONFIG: configPath, DATA_DIR: restoredDir }, async (base) => {
    const restored = await fetchSnapshot(base);
    assert.deepStrictEqual({ ...restored, serverNow: 0 }, { ...atBackup!, serverNow: 0 });
    for (const r of later.records) assert.ok(!recordedAts(restored, 'alice').includes(r.recordedAt));
  });
});

test('test-run and race events share one DB: each shows only its own window sessions', { timeout: 60_000 }, async () => {
  const { key, keyHash } = generateKey('alice');
  const testRun = writeEventConfig('test-run', 1_759_000_000_000, 1_760_500_000_000, keyHash);
  const race = writeEventConfig('race', 1_761_000_000_000, 1_762_000_000_000, keyHash);
  const dataDir = mkdtempSync(join(tmpdir(), 'rlt-events-'));
  const sessionA = mixedBatch; // starts at 1_760_000_000_000, in the test-run window
  const sessionB = sessionBatch('5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', 1_761_500_000_000);
  const aTimes = sessionA.records.filter((r) => r.kind === 'fix').map((r) => r.recordedAt);
  const bTimes = sessionB.records.filter((r) => r.kind === 'fix').map((r) => r.recordedAt);

  await withServer({ EVENT_CONFIG: testRun, DATA_DIR: dataDir }, async (base) => {
    await postBatch(base, key, sessionA);
    assert.deepStrictEqual(recordedAts(await fetchSnapshot(base), 'alice'), aTimes);
  });

  await withServer({ EVENT_CONFIG: race, DATA_DIR: dataDir }, async (base) => {
    const health = (await (await fetch(`${base}/api/v1/health`)).json()) as { eventId: string };
    assert.equal(health.eventId, 'race');
    const snap = await fetchSnapshot(base);
    assert.equal(snap.runners.find((r) => r.runnerId === 'alice')!.status, 'notStarted');
    assert.deepStrictEqual(recordedAts(snap, 'alice'), []);
    await postBatch(base, key, sessionB);
    assert.deepStrictEqual(recordedAts(await fetchSnapshot(base), 'alice'), bTimes);
  });

  await withServer({ EVENT_CONFIG: testRun, DATA_DIR: dataDir }, async (base) => {
    const health = (await (await fetch(`${base}/api/v1/health`)).json()) as { eventId: string };
    assert.equal(health.eventId, 'test-run');
    assert.deepStrictEqual(recordedAts(await fetchSnapshot(base), 'alice'), aTimes);
  });

  const db = new Database(join(dataDir, 'tracker.db'), { readonly: true });
  try {
    const sessions = db.prepare('SELECT sessionId, runnerId FROM sessions ORDER BY sessionStartedAt').all();
    assert.deepStrictEqual(sessions, [
      { sessionId: sessionA.sessionId, runnerId: 'alice' },
      { sessionId: sessionB.sessionId, runnerId: 'alice' },
    ]);
  } finally {
    db.close();
  }
});
