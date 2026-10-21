import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RunnerView, Snapshot } from '@running-live-tracker/shared';
import {
  CSV_HEADER,
  DEFAULT_INTERVAL_MS,
  UsageError,
  fileStamp,
  finalReport,
  formatRunSummary,
  parseRunLogArgs,
  runLog,
  snapshotRows,
  summarizeRun,
} from './run-log.ts';
import type { RunLogDeps, RunLogOptions, RunRow } from './run-log.ts';

const T0 = Date.UTC(2026, 10, 1, 8, 0, 0); // 2026-11-01T08:00:00Z
const MIN = 60_000;
const LENGTH_M = 12_000;

const view = (runnerId: string, over: Partial<RunnerView> = {}): RunnerView => ({
  runnerId,
  status: 'notStarted',
  runStartedAt: null,
  runEndedAt: null,
  lastFixAt: null,
  lastReceivedAt: null,
  lastPosition: null,
  distanceM: 0,
  progressM: null,
  remainingM: null,
  progressFraction: null,
  offCourse: false,
  avgPaceSPerKm: null,
  currentPaceSPerKm: null,
  etaAt: null,
  ...over,
});

const snapshot = (serverNow: number, runners: RunnerView[], lengthM: number | null = LENGTH_M): Snapshot => ({
  serverNow,
  event: {
    eventId: 'test-run-2026-11-01',
    name: 'Test run',
    hasCourse: lengthM !== null,
    lengthM,
    runners: [
      { runnerId: 'alice', displayName: 'Alice', color: '#ff0000' },
      { runnerId: 'bob', displayName: 'Bob, Jr', color: '#0000ff' },
    ],
  },
  runners,
  tracks: Object.fromEntries(runners.map((r) => [r.runnerId, []])),
});

/** Alice runs 12 km at 5:00/km from T0; a row each 5 min; the ETA overshoots by 1 min until 10 km. */
const aliceAt = (minutes: number, over: Partial<RunnerView> = {}): RunnerView => {
  const progressM = Math.min(LENGTH_M, minutes * 200);
  const finish = T0 + 60 * MIN;
  return view('alice', {
    status: 'active',
    runStartedAt: T0,
    lastFixAt: T0 + minutes * MIN,
    distanceM: progressM,
    progressM,
    remainingM: LENGTH_M - progressM,
    avgPaceSPerKm: 300.4,
    etaAt: progressM >= 1000 ? finish + (progressM < 10_000 ? MIN : -30_000) : null,
    ...over,
  });
};

const rows = (...snaps: Snapshot[]): RunRow[] => snaps.flatMap((s) => s.runners.map((v) => ({ serverNow: s.serverNow, view: v })));

// ---------------------------------------------------------------- args

test('parseRunLogArgs: defaults, interval, out, DATA_DIR', () => {
  const o = parseRunLogArgs(['--', '--base-url', 'http://127.0.0.1:8787/'], { DATA_DIR: 'x/data' }, '/repo');
  assert.deepEqual(o, { baseUrl: 'http://127.0.0.1:8787', intervalMs: DEFAULT_INTERVAL_MS, outPath: null, dataDir: resolve('x/data') });
  const p = parseRunLogArgs(['--base-url', 'https://h.ts.net', '--interval', '1m', '--out', 'a.csv'], {}, '/repo');
  assert.equal(p.intervalMs, 60_000);
  assert.equal(p.outPath, resolve('a.csv'));
  assert.equal(p.dataDir, resolve('/repo', 'data'));
});

test('parseRunLogArgs: bad args are UsageErrors', () => {
  for (const argv of [
    [],
    ['--base-url', 'ftp://x'],
    ['--base-url', 'not a url'],
    ['--base-url', 'http://x', '--interval', 'soon'],
    ['--base-url', 'http://x', '--interval', '0s'],
    ['--base-url', 'http://x', '--out', ' '],
    ['--base-url', 'http://x', '--nope'],
  ]) {
    assert.throws(() => parseRunLogArgs(argv, {}, '/repo'), UsageError, argv.join(' '));
  }
  assert.throws(() => parseRunLogArgs(['--base-url', 'http://x', '--interval', 'soon'], {}, '/repo'), /--interval/);
});

// ---------------------------------------------------------------- rows

test('snapshotRows: one row per runner, empty cells for null, quoted when needed', () => {
  const s = snapshot(T0 + 5 * MIN, [aliceAt(5), view('bob,2'), view('say "hi"')]);
  const [a, b, c] = snapshotRows(s);
  assert.equal(CSV_HEADER.split(',').length, 12);
  assert.equal(a, `${T0 + 5 * MIN},alice,active,1000,1000,11000,300.4,,${T0 + 61 * MIN},${T0 + 5 * MIN},${T0},`);
  assert.equal(b, `${T0 + 5 * MIN},"bob,2",notStarted,0,,,,,,,,`);
  assert.equal(c, `${T0 + 5 * MIN},"say ""hi""",notStarted,0,,,,,,,,`);
});

// ---------------------------------------------------------------- summary

test('summarizeRun: finish by course length, checkpoint ETA errors, not started', () => {
  const snaps = [0, 5, 10, 25, 30, 50, 55, 60, 62].map((m) => snapshot(T0 + m * MIN + 7_000, [aliceAt(m), view('bob')]));
  const [alice, bob] = summarizeRun(rows(...snaps), LENGTH_M);
  assert.equal(alice!.finishBy, 'course');
  assert.equal(alice!.finishAt, T0 + 60 * MIN); // the fix time, not the poll time
  assert.equal(alice!.elapsedMs, 60 * MIN);
  assert.equal(alice!.distanceM, LENGTH_M);
  // 5 km is first seen at 25 min (+1 min), 10 km at 50 min (−30 s); no checkpoint at 12 km.
  assert.deepEqual(
    alice!.checkpoints!.map((c) => [c.atM, c.reachedAt - T0, c.errorMs]),
    [
      [5000, 25 * MIN, MIN],
      [10_000, 50 * MIN, -30_000],
    ],
  );
  assert.equal(bob!.started, false);
  const text = formatRunSummary([alice!, bob!], new Map([['alice', 'Alice']]));
  assert.match(text, /finish {4}2026-11-01T09:00:00\.000Z \(reached the course length\)/);
  assert.match(text, /elapsed {3}1:00:00\n/);
  assert.match(text, /distance {2}12\.00 km/);
  assert.match(text, /avg pace {2}5:00 \/km/);
  assert.match(text, / {2}5 km .* \+0:01:00/);
  assert.match(text, /10 km .* -0:00:30/);
  assert.match(text, /bob \(bob\): not started/);
});

test('summarizeRun: finish by Stop when progress never reaches the course length', () => {
  const stopped = aliceAt(58, { status: 'stopped', progressM: 11_900, distanceM: 11_900, remainingM: 100, runEndedAt: T0 + 59 * MIN, etaAt: null });
  const [alice] = summarizeRun(rows(snapshot(T0 + 30 * MIN, [aliceAt(30)]), snapshot(T0 + 59 * MIN, [stopped])), LENGTH_M);
  assert.equal(alice!.finishBy, 'stop');
  assert.equal(alice!.finishAt, T0 + 59 * MIN);
  assert.deepEqual(alice!.checkpoints!.map((c) => [c.atM, c.errorMs]), [[5000, 2 * MIN]]);
  assert.equal(alice!.elapsedMs, 59 * MIN); // to the Stop, not to the last fix (58 min)
  assert.equal(alice!.shortM, 100);
  assert.match(formatRunSummary([alice!], new Map()), /\(Stop pressed, 0\.10 km before the course end: includes the delay to Stop\)/);
});

test('summarizeRun: not finished (Ctrl-C mid-run) gives elapsed to the last fix and no ETA error', () => {
  const [alice] = summarizeRun(rows(snapshot(T0 + 30 * MIN, [aliceAt(30)])), LENGTH_M);
  assert.equal(alice!.finishAt, null);
  assert.equal(alice!.elapsedMs, 30 * MIN);
  const text = formatRunSummary([alice!], new Map());
  assert.match(text, /not finished\n/);
  assert.match(text, /elapsed {3}0:30:00 \(to the last fix\)/);
  assert.match(text, /not finished: no ETA error/);
});

test('summarizeRun: no course gives no ETA', () => {
  const noCourse = (m: number, over: Partial<RunnerView> = {}) =>
    aliceAt(m, { progressM: null, remainingM: null, etaAt: null, ...over });
  const last = noCourse(60, { status: 'stopped', runEndedAt: T0 + 60 * MIN });
  const [alice] = summarizeRun(rows(snapshot(T0, [noCourse(10)], null), snapshot(T0, [last], null)), null);
  assert.equal(alice!.checkpoints, null);
  assert.equal(alice!.finishBy, 'stop');
  assert.match(formatRunSummary([alice!], new Map()), /no course: no ETA/);
});

// ---------------------------------------------------------------- loop

type Reply = Snapshot | number | Error | 'bad-json';

function fakeDeps(replies: Reply[], abortAfterPolls = Infinity, files: { existing?: boolean; failWrites?: number } = {}) {
  let failWrites = files.failWrites ?? 0;
  const controller = new AbortController();
  let now = T0;
  let polls = 0;
  const lines: { path: string; line: string }[] = [];
  const errors: string[] = [];
  const fetch = (async (_url: string | URL | Request) => {
    polls++;
    if (polls >= abortAfterPolls) controller.abort();
    const reply = replies.length > 1 ? replies.shift() : replies[0]; // the last reply repeats
    if (reply === undefined) throw new Error('no reply');
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'number') return new Response('{}', { status: reply });
    if (reply === 'bad-json') return new Response('{', { status: 200 });
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as typeof globalThis.fetch;
  const deps: RunLogDeps = {
    fetch,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    appendLine: (path, line) => {
      if (failWrites > 0) {
        failWrites--;
        throw new Error('EBUSY: resource busy or locked');
      }
      lines.push({ path, line });
    },
    hasContent: () => files.existing === true || lines.length > 0,
    log: () => {},
    error: (line) => errors.push(line),
    signal: controller.signal,
  };
  return { deps, lines, errors, polls: () => polls };
}

const options: RunLogOptions = { baseUrl: 'http://127.0.0.1:8787', intervalMs: 15_000, outPath: null, dataDir: resolve('/data') };

test('runLog: failed polls are logged and retried; stops once every runner seen active is stopped', async () => {
  const preStopped = view('bob', { status: 'stopped', runStartedAt: T0 - 600 * MIN, runEndedAt: T0 - 500 * MIN });
  const done = aliceAt(60, { status: 'stopped', runEndedAt: T0 + 60 * MIN, etaAt: null });
  const fake = fakeDeps([
    new TypeError('fetch failed'),
    503,
    'bad-json',
    { ...snapshot(T0, [aliceAt(5)]), runners: [aliceAt(5), preStopped], tracks: { alice: 'nope' } } as unknown as Snapshot,
    snapshot(T0 + MIN, [aliceAt(5), preStopped]),
    snapshot(T0 + 2 * MIN, [done, preStopped]),
    snapshot(T0 + 3 * MIN, [done, preStopped]),
  ]);
  const result = await runLog(options, fake.deps);
  assert.equal(fake.polls(), 6); // the 7th is never made
  assert.equal(fake.errors.length, 4);
  assert.match(fake.errors[0]!, /unreachable/);
  assert.match(fake.errors[1]!, /returned 503/);
  assert.match(fake.errors[2]!, /invalid JSON/);
  assert.match(fake.errors[3]!, /unexpected snapshot/);
  const expectedPath = resolve('/data', 'run-logs', `test-run-2026-11-01-${fileStamp(T0)}.csv`);
  assert.equal(fileStamp(T0), '20261101T080000Z');
  assert.ok(fake.lines.every((l) => l.path === expectedPath));
  assert.deepEqual(
    fake.lines.map((l) => l.line.split(',')[1]),
    ['runnerId', 'alice', 'bob', 'alice', 'bob'],
  );
  assert.equal(fake.lines[0]!.line, CSV_HEADER);
  assert.equal(result.rows.length, 4);
  const report = finalReport(result)!;
  assert.match(report, /^run-log: test-run-2026-11-01, course 12\.00 km, 4 rows in /);
  assert.match(report, /Alice \(alice\)/);
  assert.match(report, /Bob, Jr \(bob\): not started/); // stopped before this run, never active in it
});

test('runLog: no runner ever active keeps polling until aborted; --out is used as given', async () => {
  const fake = fakeDeps([snapshot(T0, [view('alice'), view('bob')])], 3);
  const result = await runLog({ ...options, outPath: resolve('mine.csv') }, fake.deps);
  assert.equal(fake.polls(), 3);
  assert.equal(result.outPath, resolve('mine.csv'));
  assert.equal(fake.lines.filter((l) => l.line === CSV_HEADER).length, 1);
  assert.equal(result.rows.length, 4); // the aborted third poll is not recorded
  assert.match(finalReport(result)!, /Alice \(alice\): not started/);
});

test('runLog: aborted before any snapshot gives no report', async () => {
  const fake = fakeDeps([new TypeError('fetch failed')], 1);
  const result = await runLog(options, fake.deps);
  assert.equal(result.snapshot, null);
  assert.equal(finalReport(result), null);
  assert.equal(fake.lines.length, 0);
});

test('run-log CLI: usage errors exit 1 with the usage', () => {
  const res = spawnSync(process.execPath, [join(import.meta.dirname, 'run-log.ts'), '--interval', '5s'], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Missing --base-url/);
  assert.match(res.stderr, /Usage: pnpm run-log/);
});

test('runLog: an existing --out file gets no second header', async () => {
  const fake = fakeDeps([snapshot(T0, [view('alice'), view('bob')])], 2, { existing: true });
  await runLog({ ...options, outPath: resolve('old.csv') }, fake.deps);
  assert.equal(fake.lines.filter((l) => l.line === CSV_HEADER).length, 0);
  assert.equal(fake.lines.length, 2);
});

test('runLog: a failed write (file locked) is logged and polling goes on, rows kept for the summary', async () => {
  const fake = fakeDeps([snapshot(T0, [view('alice'), view('bob')])], 3, { failWrites: 1 });
  const result = await runLog(options, fake.deps);
  assert.equal(fake.errors.length, 1);
  assert.match(fake.errors[0]!, /cannot write .*EBUSY.*rows kept for the summary/);
  assert.equal(fake.lines[0]!.line, CSV_HEADER); // the header is retried on the next poll
  assert.equal(fake.lines.length, 3);
  assert.equal(result.rows.length, 4);
});

test('run-log CLI: records to DATA_DIR/run-logs and prints the summary, exit 0', { timeout: 20_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rlt-run-log-cli-'));
  const done = aliceAt(60, { status: 'stopped', runEndedAt: T0 + 60 * MIN, etaAt: null });
  const replies = [snapshot(T0, [aliceAt(30), view('bob')]), snapshot(T0 + MIN, [done, view('bob')])];
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(replies.length > 1 ? replies.shift() : replies[0]));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveRun) => {
      // Async spawn: spawnSync would block the stub server's event loop.
      execFile(
        process.execPath,
        [join(import.meta.dirname, 'run-log.ts'), '--base-url', `http://127.0.0.1:${port}`, '--interval', '0.2s'],
        { env: { ...process.env, DATA_DIR: dataDir } },
        (err, stdout, stderr) => resolveRun({ status: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      );
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /run-log: test-run-2026-11-01, course 12\.00 km, 4 rows in /);
    assert.match(res.stdout, /finish {4}2026-11-01T09:00:00\.000Z \(reached the course length\)/);
    const files = readdirSync(join(dataDir, 'run-logs'));
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^test-run-2026-11-01-\d{8}T\d{6}Z\.csv$/);
    const csv = readFileSync(join(dataDir, 'run-logs', files[0]!), 'utf8').trimEnd().split('\n');
    assert.equal(csv[0], CSV_HEADER);
    assert.equal(csv.length, 5);
  } finally {
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
