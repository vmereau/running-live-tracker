import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  DEFAULT_GAP_MS,
  UsageError,
  formatSessionReport,
  formatSpan,
  parseSessionReportArgs,
  summarizeSession,
  verdict,
} from './session-report.ts';
import type { RecordRow, SessionRow } from './session-report.ts';

const scriptPath = join(import.meta.dirname, 'session-report.ts');
const T0 = Date.UTC(2026, 9, 21, 8, 0, 0); // 2026-10-21T08:00:00Z
const HOUR = 3_600_000;

// Copy of the schema in server/src/store/open-store.ts (scripts may not import store/).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  sessionId        TEXT    NOT NULL PRIMARY KEY,
  runnerId         TEXT    NOT NULL,
  sessionStartedAt INTEGER NOT NULL,
  firstReceivedAt  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
  sessionId  TEXT    NOT NULL REFERENCES sessions (sessionId),
  seq        INTEGER NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('fix', 'end')),
  recordedAt INTEGER NOT NULL,
  receivedAt INTEGER NOT NULL,
  lat        REAL,
  lon        REAL,
  accuracyM  REAL,
  altitudeM  REAL,
  speedMps   REAL,
  PRIMARY KEY (sessionId, seq)
);
`;

const session = (sessionId = 's1', runnerId = 'alice', sessionStartedAt = T0): SessionRow => ({
  sessionId,
  runnerId,
  sessionStartedAt,
});

/** n fixes every 5 s heading north (~0.0001° lat ≈ 11.1 m apart), then optionally an end. */
function track(n: number, { end = true, start = T0, delayMs = 2_000 } = {}): RecordRow[] {
  const out: RecordRow[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ seq: i, kind: 'fix', recordedAt: start + i * 5_000, receivedAt: start + i * 5_000 + delayMs, lat: 48 + i * 0.0001, lon: 2, });
  }
  if (end) out.push({ seq: n, kind: 'end', recordedAt: start + n * 5_000, receivedAt: start + n * 5_000 + delayMs, lat: null, lon: null });
  return out;
}

// ---------------------------------------------------------------- summarizeSession

test('a contiguous session ending with end is COMPLETE with its figures', () => {
  const s = summarizeSession(session(), track(11), DEFAULT_GAP_MS);
  assert.equal(s.complete, true);
  assert.equal(verdict(s), 'COMPLETE');
  assert.equal(s.fixCount, 11);
  assert.equal(s.firstFixAt, T0);
  assert.equal(s.lastFixAt, T0 + 50_000);
  assert.equal(s.durationMs, 50_000);
  assert.equal(s.endAt, T0 + 55_000);
  assert.ok(Math.abs(s.distanceM - 111.2) < 0.5, String(s.distanceM));
  assert.deepStrictEqual(s.missing, []);
  assert.equal(s.maxGapMs, 5_000);
  assert.deepStrictEqual(s.gaps, []);
  assert.deepStrictEqual(s.uploadGaps, []);
  assert.equal(s.maxUploadDelayMs, 2_000);
});

test('records in any order give the same summary', () => {
  const records = track(6);
  assert.deepStrictEqual(summarizeSession(session(), [...records].reverse(), DEFAULT_GAP_MS), summarizeSession(session(), records, DEFAULT_GAP_MS));
});

test('missing seq ranges make the session INCOMPLETE and are listed', () => {
  const records = track(20).filter((r) => !(r.seq >= 12 && r.seq <= 15) && r.seq !== 0 && r.seq !== 18);
  const s = summarizeSession(session(), records, DEFAULT_GAP_MS);
  assert.equal(s.complete, false);
  assert.equal(verdict(s), 'INCOMPLETE');
  assert.deepStrictEqual(s.missing, [
    { from: 0, to: 0 },
    { from: 12, to: 15 },
    { from: 18, to: 18 },
  ]);
});

test('no end record is INCOMPLETE (no end)', () => {
  const s = summarizeSession(session(), track(5, { end: false }), DEFAULT_GAP_MS);
  assert.equal(s.complete, false);
  assert.equal(s.endAt, null);
  assert.deepStrictEqual(s.missing, []);
  assert.equal(verdict(s), 'INCOMPLETE (no end)');
});

test('a signal gap over the threshold is listed but does not change the verdict', () => {
  const records = track(10).map((r) => (r.seq >= 5 ? { ...r, recordedAt: r.recordedAt + 10 * 60_000, receivedAt: r.receivedAt + 10 * 60_000 } : r));
  const s = summarizeSession(session(), records, DEFAULT_GAP_MS);
  assert.equal(s.complete, true);
  assert.deepStrictEqual(s.gaps, [{ fromMs: T0 + 20_000, toMs: T0 + 25_000 + 10 * 60_000, lengthMs: 605_000 }]);
  assert.equal(s.maxGapMs, 605_000);
  assert.equal(s.uploadGaps.length, 1);
  // A gap equal to the threshold is not listed.
  assert.deepStrictEqual(summarizeSession(session(), track(3), 5_000).gaps, []);
  assert.equal(summarizeSession(session(), track(3), 4_999).gaps.length, 2);
});

test('an offline period (fixes recorded, backlog received later) is an upload gap, not a track gap', () => {
  // From seq 4 on, records were held in the outbox and arrived in seq order from T0 + 5 min.
  const records = track(10).map((r) => (r.seq >= 4 ? { ...r, receivedAt: T0 + 300_000 + (r.seq - 4) * 100 } : r));
  const s = summarizeSession(session(), records, DEFAULT_GAP_MS);
  assert.equal(s.complete, true);
  assert.deepStrictEqual(s.gaps, []);
  assert.deepStrictEqual(s.uploadGaps, [{ fromMs: T0 + 17_000, toMs: T0 + 300_000, lengthMs: 283_000 }]);
  // seq 4: recorded at T0 + 20 s, received at T0 + 5 min.
  assert.equal(s.maxUploadDelayMs, 300_000 - 20_000);
});

test('a session with only an end has no fixes, no distance and no gaps', () => {
  const s = summarizeSession(session(), [{ seq: 0, kind: 'end', recordedAt: T0, receivedAt: T0 + 1, lat: null, lon: null }], DEFAULT_GAP_MS);
  assert.equal(s.complete, true);
  assert.equal(s.fixCount, 0);
  assert.equal(s.durationMs, null);
  assert.equal(s.distanceM, 0);
  assert.equal(s.maxGapMs, null);
});

// ---------------------------------------------------------------- formatting

test('formatSpan', () => {
  assert.equal(formatSpan(0), '0:00:00');
  assert.equal(formatSpan(30_000), '0:00:30');
  assert.equal(formatSpan(5 * HOUR + 62_000), '5:01:02');
  assert.equal(formatSpan(-3_000), '-0:00:03');
  assert.equal(formatSpan(-400), '0:00:00');
});

test('formatSessionReport shows the display name, the gaps and missing ranges, and a summary line', () => {
  const ok = summarizeSession(session('s1', 'alice'), track(3), 4_000);
  const bad = summarizeSession(session('s2', 'ghost'), track(20, { end: false }).filter((r) => r.seq < 12 || r.seq > 15), DEFAULT_GAP_MS);
  const text = formatSessionReport([ok, bad], new Map([['alice', 'Alice']]));
  assert.match(text, /^Alice \(alice\)  session s1  COMPLETE$/m);
  assert.match(text, /^ghost  session s2  INCOMPLETE \(no end\)$/m);
  assert.match(text, /started +2026-10-21T08:00:00\.000Z/);
  assert.match(text, /fixes +3, 2026-10-21T08:00:00\.000Z → 2026-10-21T08:00:10\.000Z \(0:00:10\)/);
  assert.match(text, /distance +0\.02 km/);
  assert.match(text, /end +2026-10-21T08:00:15\.000Z/);
  assert.match(text, /end +not received/);
  assert.match(text, /missing +12\.\.15/);
  assert.match(text, /track gaps > 0:00:04 2\n +2026-10-21T08:00:00\.000Z → 2026-10-21T08:00:05\.000Z  0:00:05/);
  assert.match(text, /upload gaps > 0:00:04 3\n +2026-10-21T08:00:02\.000Z → 2026-10-21T08:00:07\.000Z  0:00:05/);
  assert.match(text, /track gaps > 0:00:30 none/);
  assert.match(text, /max upload +0:00:02/);
  assert.match(text, /2 sessions: 1 complete, 1 incomplete$/);
});

// ---------------------------------------------------------------- args

test('parseSessionReportArgs defaults and options', () => {
  const root = resolve('/repo');
  assert.deepStrictEqual(parseSessionReportArgs([], {}, root), {
    configPath: resolve(root, 'config', 'event.json'),
    dataDir: resolve(root, 'data'),
    sessionId: null,
    gapMs: 30_000,
  });
  const env = { EVENT_CONFIG: '/x/event.json', DATA_DIR: '/d' };
  assert.deepStrictEqual(parseSessionReportArgs(['--', '--session', 'abc', '--gap', '5m'], env, root), {
    configPath: resolve('/x/event.json'),
    dataDir: resolve('/d'),
    sessionId: 'abc',
    gapMs: 300_000,
  });
  assert.equal(parseSessionReportArgs(['--config', 'c.json'], env, root).configPath, resolve('c.json'));
});

test('parseSessionReportArgs rejects bad arguments with a UsageError', () => {
  for (const argv of [['--gap', 'soon'], ['--gap', '0'], ['--nope'], ['positional'], ['--session', ' '], ['--gap']]) {
    assert.throws(() => parseSessionReportArgs(argv, {}, '/repo'), UsageError, argv.join(' '));
  }
});

// ---------------------------------------------------------------- CLI

function writeConfig(dir: string, opensAt = T0 - HOUR, closesAt = T0 + 10 * HOUR): string {
  const path = join(dir, 'event.json');
  writeFileSync(path, JSON.stringify({ eventId: 'dry-run', opensAt, closesAt, runners: [{ runnerId: 'alice', displayName: 'Alice' }] }));
  return path;
}

/** A temp data dir with a WAL tracker.db; the writer connection stays open, as when the server runs. */
function liveDataDir(sessions: { s: SessionRow; records: RecordRow[] }[]) {
  const dataDir = mkdtempSync(join(tmpdir(), 'rlt-session-report-'));
  const db = new Database(join(dataDir, 'tracker.db'));
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  const insS = db.prepare('INSERT INTO sessions (sessionId, runnerId, sessionStartedAt, firstReceivedAt) VALUES (?, ?, ?, ?)');
  const insR = db.prepare(
    'INSERT INTO records (sessionId, seq, kind, recordedAt, receivedAt, lat, lon, accuracyM) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const { s, records } of sessions) {
    insS.run(s.sessionId, s.runnerId, s.sessionStartedAt, s.sessionStartedAt + 1000);
    for (const r of records) insR.run(s.sessionId, r.seq, r.kind, r.recordedAt, r.receivedAt, r.lat, r.lon, r.lat === null ? null : 5);
  }
  return { dataDir, db };
}

function run(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

test('CLI reports the sessions in the window, in start order, while a writer is open; exit 0 when all complete', () => {
  const { dataDir, db } = liveDataDir([
    { s: session('late', 'bob', T0 + HOUR), records: track(4, { start: T0 + HOUR }) },
    { s: session('early', 'alice', T0), records: track(4) },
    { s: session('before', 'alice', T0 - 2 * HOUR), records: track(2, { end: false, start: T0 - 2 * HOUR }) },
  ]);
  try {
    const before = db.prepare('SELECT COUNT(*) AS n FROM records').get();
    const res = run(['--config', writeConfig(dataDir)], { DATA_DIR: dataDir });
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /^session-report: dry-run window \(2026-10-21T07:00:00\.000Z – 2026-10-21T18:00:00\.000Z\)/);
    assert.ok(res.stdout.indexOf('session early') < res.stdout.indexOf('session late'));
    assert.ok(!res.stdout.includes('session before'));
    assert.match(res.stdout, /Alice \(alice\)  session early  COMPLETE/);
    assert.match(res.stdout, /^bob  session late  COMPLETE$/m);
    assert.match(res.stdout, /2 sessions: 2 complete, 0 incomplete/);
    assert.deepStrictEqual(db.prepare('SELECT COUNT(*) AS n FROM records').get(), before);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('CLI exits 1 when a session is incomplete', () => {
  const { dataDir, db } = liveDataDir([{ s: session('s1'), records: track(20).filter((r) => r.seq < 12 || r.seq > 15) }]);
  try {
    const res = run([], { DATA_DIR: dataDir, EVENT_CONFIG: writeConfig(dataDir) });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /session s1  INCOMPLETE$/m);
    assert.match(res.stdout, /missing +12\.\.15/);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('CLI --session reports that session regardless of the window; unknown id exits 1', () => {
  const { dataDir, db } = liveDataDir([{ s: session('old', 'alice', T0 - 5 * HOUR), records: track(3, { start: T0 - 5 * HOUR }) }]);
  try {
    const config = writeConfig(dataDir);
    const res = run(['--config', config, '--session', 'old'], { DATA_DIR: dataDir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /session old  COMPLETE/);
    const unknown = run(['--config', config, '--session', 'nope'], { DATA_DIR: dataDir });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /no session "nope"/);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('CLI exits 1 with a message when no session is in the window', () => {
  const { dataDir, db } = liveDataDir([{ s: session('old', 'alice', T0 - 5 * HOUR), records: track(3) }]);
  try {
    const res = run(['--config', writeConfig(dataDir)], { DATA_DIR: dataDir });
    assert.equal(res.status, 1);
    assert.equal(res.stderr.trim(), 'no sessions in dry-run window (2026-10-21T07:00:00.000Z – 2026-10-21T18:00:00.000Z)');
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('CLI: missing DB, bad config and bad args give one line (plus usage), no stack trace, exit 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rlt-session-report-empty-'));
  try {
    const config = writeConfig(dir);
    const noDb = run(['--config', config], { DATA_DIR: dir });
    assert.equal(noDb.status, 1);
    assert.match(noDb.stderr, /^session-report failed: Cannot open the data store at .*tracker\.db/);
    assert.equal(noDb.stderr.trim().split('\n').length, 1);

    const badConfigPath = join(dir, 'bad.json');
    writeFileSync(badConfigPath, '{"eventId": 3}');
    const badConfig = run(['--config', badConfigPath], { DATA_DIR: dir });
    assert.equal(badConfig.status, 1);
    assert.match(badConfig.stderr, /^session-report failed: invalid config/);
    assert.equal(badConfig.stderr.trim().split('\n').length, 1);

    const badArgs = run(['--gap', 'soon'], { DATA_DIR: dir });
    assert.equal(badArgs.status, 1);
    assert.match(badArgs.stderr, /^Invalid --gap "soon"/);
    assert.match(badArgs.stderr, /Usage: pnpm session-report/);
    assert.ok(!/\bat .*\.ts:\d+/.test(noDb.stderr + badConfig.stderr + badArgs.stderr));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI window bounds are inclusive: starts at opensAt and closesAt are reported, closesAt + 1 is not', () => {
  const opensAt = T0;
  const closesAt = T0 + HOUR;
  const { dataDir, db } = liveDataDir([
    { s: session('at-open', 'alice', opensAt), records: track(2, { start: opensAt }) },
    { s: session('at-close', 'alice', closesAt), records: track(2, { start: closesAt }) },
    { s: session('after-close', 'alice', closesAt + 1), records: track(2, { start: closesAt + 1 }) },
  ]);
  try {
    const res = run(['--config', writeConfig(dataDir, opensAt, closesAt)], { DATA_DIR: dataDir });
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /session at-open  COMPLETE/);
    assert.match(res.stdout, /session at-close  COMPLETE/);
    assert.ok(!res.stdout.includes('after-close'));
    assert.match(res.stdout, /2 sessions: 2 complete, 0 incomplete/);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
