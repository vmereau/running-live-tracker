// pnpm session-report: read-only report of the stored sessions of an event, the server-side
// proof for the public dry run and the phone soak test (docs/ops/race-readiness.md).
// Per session: fixes, duration, distance, whether `end` arrived, missing seqs, gaps between
// fixes over --gap (track gaps: no position recorded), upload gaps (nothing received for more
// than --gap: the phone or simulator was offline and uploaded its backlog later), and the
// upload delay. A missing seq or a missing `end` is INCOMPLETE (lost data); gaps are listed
// for the human to match with places without signal.
// It reads the config JSON and tracker.db itself: server/scripts may not import server/src/store.
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { cumulativeDistancesM } from '../src/domain/geo.ts';
import { UsageError, readConfigFile } from './race-check.ts';
import type { RaceConfig } from './race-check.ts';
import { parseDurationMs } from './simulate-runner.ts';

export { UsageError };

export const DEFAULT_GAP_MS = 30_000;

export const USAGE = [
  'Usage: pnpm session-report [--config <event.json>] [--session <sessionId>] [--gap 30s]',
  '  --config   event config whose window and runners to use (default: EVENT_CONFIG, else config/event.json)',
  '  --session  report only this session, whatever its start time',
  '  --gap      threshold for both track gaps (between fixes, by recorded time) and upload gaps',
  '             (between records, by server receive time); default 30s, e.g. 30s, 5m',
  'Reads <DATA_DIR>/tracker.db (default data/). Exit 0 only when every reported session is COMPLETE.',
].join('\n');

export type SessionReportOptions = { configPath: string; dataDir: string; sessionId: string | null; gapMs: number };

export function parseSessionReportArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  repoRoot = resolve(import.meta.dirname, '..', '..'),
): SessionReportOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv[0] === '--' ? argv.slice(1) : [...argv],
      strict: true,
      allowPositionals: false,
      options: { config: { type: 'string' }, session: { type: 'string' }, gap: { type: 'string' } },
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  let gapMs = DEFAULT_GAP_MS;
  if (values.gap !== undefined) {
    try {
      gapMs = parseDurationMs(values.gap);
    } catch (err) {
      throw new UsageError((err as Error).message.replace('duration', '--gap'));
    }
    if (gapMs <= 0) throw new UsageError(`Invalid --gap "${values.gap}": must be positive`);
  }
  if (values.session !== undefined && values.session.trim() === '') throw new UsageError('--session must not be empty');
  // Same EVENT_CONFIG / DATA_DIR env and defaults as server/src/main.ts.
  const configPath = resolve(values.config ?? env['EVENT_CONFIG'] ?? resolve(repoRoot, 'config', 'event.json'));
  const dataDir = resolve(env['DATA_DIR'] ?? resolve(repoRoot, 'data'));
  return { configPath, dataDir, sessionId: values.session ?? null, gapMs };
}

/** A `sessions` row (the schema is in server/src/store/open-store.ts). */
export type SessionRow = { sessionId: string; runnerId: string; sessionStartedAt: number };
/** The `records` columns the report uses. lat/lon are NULL for `end`. */
export type RecordRow = {
  seq: number;
  kind: 'fix' | 'end';
  recordedAt: number;
  receivedAt: number;
  lat: number | null;
  lon: number | null;
};

export type Gap = { fromMs: number; toMs: number; lengthMs: number };
export type SeqRange = { from: number; to: number };

export type SessionSummary = {
  sessionId: string;
  runnerId: string;
  sessionStartedAt: number;
  fixCount: number;
  /** recordedAt of the first and last fix; null without fixes. */
  firstFixAt: number | null;
  lastFixAt: number | null;
  durationMs: number | null;
  distanceM: number;
  /** recordedAt of the `end` record; null when it has not arrived. */
  endAt: number | null;
  /** Seq ranges absent from 0..max stored seq. */
  missing: SeqRange[];
  /** Longest time between consecutive fixes; null with fewer than 2 fixes. */
  maxGapMs: number | null;
  /** Consecutive fixes more than gapMs apart (recordedAt): no position was recorded. */
  gaps: Gap[];
  /** Records consecutive in receivedAt order received more than gapMs apart: nothing reached the server. */
  uploadGaps: Gap[];
  gapThresholdMs: number;
  /** Largest receivedAt - recordedAt over all records; null without records. */
  maxUploadDelayMs: number | null;
  complete: boolean;
};

/** Pure summary of one session's stored records (any order). */
export function summarizeSession(session: SessionRow, records: readonly RecordRow[], gapMs: number): SessionSummary {
  const sorted = [...records].sort((a, b) => a.seq - b.seq);

  const missing: SeqRange[] = [];
  let expected = 0;
  for (const r of sorted) {
    if (r.seq > expected) missing.push({ from: expected, to: r.seq - 1 });
    expected = Math.max(expected, r.seq + 1);
  }

  const fixes = sorted.filter((r) => r.kind === 'fix' && r.lat !== null && r.lon !== null);
  const end = sorted.find((r) => r.kind === 'end');

  const gaps: Gap[] = [];
  let maxGapMs: number | null = null;
  for (let i = 1; i < fixes.length; i++) {
    const fromMs = fixes[i - 1]!.recordedAt;
    const toMs = fixes[i]!.recordedAt;
    const lengthMs = toMs - fromMs;
    if (maxGapMs === null || lengthMs > maxGapMs) maxGapMs = lengthMs;
    if (lengthMs > gapMs) gaps.push({ fromMs, toMs, lengthMs });
  }

  const byReceived = [...sorted].sort((a, b) => a.receivedAt - b.receivedAt || a.seq - b.seq);
  const uploadGaps: Gap[] = [];
  for (let i = 1; i < byReceived.length; i++) {
    const fromMs = byReceived[i - 1]!.receivedAt;
    const toMs = byReceived[i]!.receivedAt;
    if (toMs - fromMs > gapMs) uploadGaps.push({ fromMs, toMs, lengthMs: toMs - fromMs });
  }

  const distances = cumulativeDistancesM(fixes.map((f) => ({ lat: f.lat!, lon: f.lon! })));
  const firstFixAt = fixes[0]?.recordedAt ?? null;
  const lastFixAt = fixes.at(-1)?.recordedAt ?? null;
  const delays = sorted.map((r) => r.receivedAt - r.recordedAt);

  return {
    sessionId: session.sessionId,
    runnerId: session.runnerId,
    sessionStartedAt: session.sessionStartedAt,
    fixCount: fixes.length,
    firstFixAt,
    lastFixAt,
    durationMs: firstFixAt === null || lastFixAt === null ? null : lastFixAt - firstFixAt,
    distanceM: distances.at(-1) ?? 0,
    endAt: end?.recordedAt ?? null,
    missing,
    maxGapMs,
    gaps,
    uploadGaps,
    gapThresholdMs: gapMs,
    maxUploadDelayMs: delays.length === 0 ? null : Math.max(...delays),
    complete: missing.length === 0 && end !== undefined,
  };
}

export function verdict(s: SessionSummary): string {
  if (s.complete) return 'COMPLETE';
  return s.endAt === null ? 'INCOMPLETE (no end)' : 'INCOMPLETE';
}

const iso = (ms: number) => new Date(ms).toISOString();

/** "h:mm:ss", with a leading "-" for a negative span. */
export function formatSpan(ms: number): string {
  const total = Math.round(Math.abs(ms) / 1000);
  const sign = ms < 0 && total > 0 ? '-' : '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${sign}${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const formatRange = (r: SeqRange) => (r.from === r.to ? `${r.from}` : `${r.from}..${r.to}`);

/** One block per session plus a summary line. `runnerNames` maps runnerId to display name. */
export function formatSessionReport(summaries: readonly SessionSummary[], runnerNames: ReadonlyMap<string, string>): string {
  const blocks = summaries.map((s) => {
    const name = runnerNames.get(s.runnerId);
    const who = name === undefined ? s.runnerId : `${name} (${s.runnerId})`;
    const over = `> ${formatSpan(s.gapThresholdMs)}`;
    const gapLines = (label: string, gaps: readonly Gap[]) => [
      `  ${label.padEnd(12)} ${gaps.length === 0 ? 'none' : gaps.length}`,
      ...gaps.map((g) => `    ${iso(g.fromMs)} → ${iso(g.toMs)}  ${formatSpan(g.lengthMs)}`),
    ];
    const lines = [
      `${who}  session ${s.sessionId}  ${verdict(s)}`,
      `  started      ${iso(s.sessionStartedAt)}`,
      s.firstFixAt === null || s.lastFixAt === null
        ? `  fixes        0`
        : `  fixes        ${s.fixCount}, ${iso(s.firstFixAt)} → ${iso(s.lastFixAt)} (${formatSpan(s.durationMs!)})`,
      `  distance     ${(s.distanceM / 1000).toFixed(2)} km`,
      `  end          ${s.endAt === null ? 'not received' : iso(s.endAt)}`,
      `  missing      ${s.missing.length === 0 ? 'none' : s.missing.map(formatRange).join(', ')}`,
      `  max gap      ${s.maxGapMs === null ? '-' : formatSpan(s.maxGapMs)}`,
      ...gapLines(`track gaps ${over}`, s.gaps),
      ...gapLines(`upload gaps ${over}`, s.uploadGaps),
      `  max upload   ${s.maxUploadDelayMs === null ? '-' : formatSpan(s.maxUploadDelayMs)}`,
    ];
    return lines.join('\n');
  });
  const complete = summaries.filter((s) => s.complete).length;
  const n = summaries.length;
  blocks.push(`${n} session${n === 1 ? '' : 's'}: ${complete} complete, ${n - complete} incomplete`);
  return blocks.join('\n\n');
}

/** Opens <dataDir>/tracker.db read-only; throws naming the path when it is missing. */
export function openReadOnly(dataDir: string): Database.Database {
  const dbPath = join(dataDir, 'tracker.db');
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw new Error(`Cannot open the data store at ${dbPath}: ${(err as Error).message}`);
  }
}

/** Builds the report text and exit code from an open DB and a config. */
export function sessionReport(
  db: Database.Database,
  config: RaceConfig,
  options: Pick<SessionReportOptions, 'sessionId' | 'gapMs'>,
): { text: string; exitCode: number } {
  const window = `${config.eventId} window (${iso(config.opensAt)} – ${iso(config.closesAt)})`;
  const sessionCols = 'SELECT sessionId, runnerId, sessionStartedAt FROM sessions';
  let sessions: SessionRow[];
  let header: string;
  if (options.sessionId !== null) {
    sessions = db.prepare(`${sessionCols} WHERE sessionId = ?`).all(options.sessionId) as SessionRow[];
    if (sessions.length === 0) return { text: `no session "${options.sessionId}" in the data store`, exitCode: 1 };
    header = `session-report: session ${options.sessionId}`;
  } else {
    sessions = db
      .prepare(`${sessionCols} WHERE sessionStartedAt BETWEEN ? AND ? ORDER BY sessionStartedAt, sessionId`)
      .all(config.opensAt, config.closesAt) as SessionRow[];
    if (sessions.length === 0) return { text: `no sessions in ${window}`, exitCode: 1 };
    header = `session-report: ${window}`;
  }
  const recordsOf = db.prepare(
    'SELECT seq, kind, recordedAt, receivedAt, lat, lon FROM records WHERE sessionId = ? ORDER BY seq',
  );
  const summaries = sessions.map((s) => summarizeSession(s, recordsOf.all(s.sessionId) as RecordRow[], options.gapMs));
  const names = new Map(config.runners.map((r) => [r.runnerId, r.displayName]));
  return {
    text: `${header}\n\n${formatSessionReport(summaries, names)}`,
    exitCode: summaries.every((s) => s.complete) ? 0 : 1,
  };
}

export function main(argv: readonly string[], env: Record<string, string | undefined> = process.env): number {
  let options: SessionReportOptions;
  try {
    options = parseSessionReportArgs(argv, env);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${USAGE}`);
    return 1;
  }
  let db: Database.Database | null = null;
  try {
    const config = readConfigFile(options.configPath);
    db = openReadOnly(options.dataDir);
    const { text, exitCode } = sessionReport(db, config, options);
    if (exitCode === 0) console.log(text);
    else (text.startsWith('session-report:') ? console.log : console.error)(text);
    return exitCode;
  } catch (err) {
    console.error(`session-report failed: ${(err as Error).message.split('\n')[0]}`);
    return 1;
  } finally {
    db?.close();
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
