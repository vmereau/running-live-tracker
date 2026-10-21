// pnpm run-log: records what the page showed during a test run (docs/ops/race-readiness.md).
// Polls GET /api/v1/snapshot every --interval and appends one CSV row per runner, then, once
// every runner that started in this run is stopped (or on Ctrl-C), prints a per-runner
// tolerance summary: finish, elapsed, distance, average pace, and the ETA error at each 5 km
// checkpoint against the actual finish. The ETA is derived live and never stored, so sampling
// the snapshot is the only way to measure it afterwards. HTTP only: no DB, no keys.
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { Snapshot } from '@running-live-tracker/shared';
import type { RunnerView } from '@running-live-tracker/shared';
import { UsageError, parseBaseUrl } from './race-check.ts';
import { formatSpan } from './session-report.ts';
import { formatPace, parseDurationMs } from './simulate-runner.ts';

export { UsageError };

export const DEFAULT_INTERVAL_MS = 15_000;
export const REQUEST_TIMEOUT_MS = 10_000;
/** The ETA error is measured each time a runner passes a multiple of this distance (m). */
export const CHECKPOINT_M = 5_000;

export const USAGE = [
  'Usage: pnpm run-log --base-url <url> [--interval 15s] [--out <file.csv>]',
  '  --base-url  server URL; on the home PC use http://127.0.0.1:8787 (each snapshot carries every track)',
  '  --interval  time between snapshots (default 15s, e.g. 15s, 1m)',
  '  --out       CSV file to append to (default: <DATA_DIR>/run-logs/<eventId>-<UTC start>.csv)',
  'Stops when every runner that started in this run is stopped, or on Ctrl-C, and prints the summary.',
].join('\n');

export type RunLogOptions = { baseUrl: string; intervalMs: number; outPath: string | null; dataDir: string };

export function parseRunLogArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  repoRoot = resolve(import.meta.dirname, '..', '..'),
): RunLogOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv[0] === '--' ? argv.slice(1) : [...argv],
      strict: true,
      allowPositionals: false,
      options: { 'base-url': { type: 'string' }, interval: { type: 'string' }, out: { type: 'string' } },
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const baseUrl = parseBaseUrl(values['base-url']);
  let intervalMs = DEFAULT_INTERVAL_MS;
  if (values.interval !== undefined) {
    try {
      intervalMs = parseDurationMs(values.interval);
    } catch (err) {
      throw new UsageError((err as Error).message.replace('duration', '--interval'));
    }
    if (intervalMs <= 0) throw new UsageError(`Invalid --interval "${values.interval}": must be positive`);
  }
  if (values.out !== undefined && values.out.trim() === '') throw new UsageError('--out must not be empty');
  // Same DATA_DIR env and default as server/src/main.ts.
  const dataDir = resolve(env['DATA_DIR'] ?? resolve(repoRoot, 'data'));
  return { baseUrl, intervalMs, outPath: values.out === undefined ? null : resolve(values.out), dataDir };
}

// ---------------------------------------------------------------- rows

/** One runner's view at one poll. */
export type RunRow = { serverNow: number; view: RunnerView };

export const CSV_COLUMNS = [
  'serverNow',
  'runnerId',
  'status',
  'distanceM',
  'progressM',
  'remainingM',
  'avgPaceSPerKm',
  'currentPaceSPerKm',
  'etaAt',
  'lastFixAt',
  'runStartedAt',
  'runEndedAt',
] as const;

export const CSV_HEADER = CSV_COLUMNS.join(',');

const csvCell = (value: string | number | null): string => {
  if (value === null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function toRunRows(snapshot: Snapshot): RunRow[] {
  return snapshot.runners.map((view) => ({ serverNow: snapshot.serverNow, view }));
}

export function formatCsvRow(row: RunRow): string {
  const v = row.view;
  return [
    row.serverNow,
    v.runnerId,
    v.status,
    v.distanceM,
    v.progressM,
    v.remainingM,
    v.avgPaceSPerKm,
    v.currentPaceSPerKm,
    v.etaAt,
    v.lastFixAt,
    v.runStartedAt,
    v.runEndedAt,
  ]
    .map(csvCell)
    .join(',');
}

/** The CSV lines of one snapshot: one per configured runner, in config order. */
export function snapshotRows(snapshot: Snapshot): string[] {
  return toRunRows(snapshot).map(formatCsvRow);
}

// ---------------------------------------------------------------- summary

export type Checkpoint = { atM: number; reachedAt: number; etaAt: number; errorMs: number };

export type RunnerSummary = {
  runnerId: string;
  started: boolean;
  runStartedAt: number | null;
  /** When the runner finished (recorded time), or null if not finished in the rows. */
  finishAt: number | null;
  finishBy: 'course' | 'stop' | null;
  /** With a Stop finish and a course: the course metres left at the last row (the matching never reached the end). */
  shortM: number | null;
  /** finish − start, or last fix − start when not finished. */
  elapsedMs: number | null;
  distanceM: number;
  avgPaceSPerKm: number | null;
  /** Null without a course (no ETA). */
  checkpoints: Checkpoint[] | null;
};

/**
 * Per runner (first-appearance order): the finish is the last fix time of the first row with
 * progressM ≥ lengthM, else the last row's runEndedAt; for each CHECKPOINT_M multiple below
 * lengthM, the first row at or past it with an etaAt gives ETA − finish.
 */
export function summarizeRun(rows: readonly RunRow[], lengthM: number | null): RunnerSummary[] {
  const byRunner = new Map<string, RunnerView[]>();
  for (const { view } of rows) {
    const list = byRunner.get(view.runnerId);
    if (list === undefined) byRunner.set(view.runnerId, [view]);
    else list.push(view);
  }
  return [...byRunner].map(([runnerId, views]) => {
    const last = views[views.length - 1]!;
    // Started in this run: seen active, not just stopped from an earlier session.
    const started = views.some((v) => v.status === 'active');
    const reached = lengthM === null ? undefined : views.find((v) => v.progressM !== null && v.progressM >= lengthM && v.lastFixAt !== null);
    let finishAt: number | null = null;
    let finishBy: RunnerSummary['finishBy'] = null;
    if (reached !== undefined) {
      finishAt = reached.lastFixAt;
      finishBy = 'course';
    } else if (last.runEndedAt !== null) {
      finishAt = last.runEndedAt;
      finishBy = 'stop';
    }
    const endAt = finishAt ?? last.lastFixAt;
    const elapsedMs = last.runStartedAt === null || endAt === null ? null : endAt - last.runStartedAt;
    let checkpoints: Checkpoint[] | null = null;
    if (lengthM !== null) {
      checkpoints = [];
      if (finishAt !== null) {
        for (let atM = CHECKPOINT_M; atM < lengthM; atM += CHECKPOINT_M) {
          const v = views.find((x) => x.distanceM >= atM && x.etaAt !== null && x.lastFixAt !== null);
          if (v === undefined) continue;
          checkpoints.push({ atM, reachedAt: v.lastFixAt!, etaAt: v.etaAt!, errorMs: v.etaAt! - finishAt });
        }
      }
    }
    return {
      runnerId,
      started,
      runStartedAt: last.runStartedAt,
      finishAt,
      finishBy,
      shortM: finishBy === 'stop' && last.remainingM !== null && last.remainingM > 0 ? last.remainingM : null,
      elapsedMs,
      distanceM: last.distanceM,
      avgPaceSPerKm: last.avgPaceSPerKm,
      checkpoints,
    };
  });
}

const iso = (ms: number) => new Date(ms).toISOString();
/** "+0:02:15" (ETA later than the finish) / "-0:01:05" (earlier). */
const signedSpan = (ms: number) => (ms > 0 ? `+${formatSpan(ms)}` : formatSpan(ms));

/** One block per runner. `runnerNames` maps runnerId to display name. */
export function formatRunSummary(summaries: readonly RunnerSummary[], runnerNames: ReadonlyMap<string, string>): string {
  return summaries
    .map((s) => {
      const name = runnerNames.get(s.runnerId) ?? s.runnerId;
      if (!s.started) return `${name} (${s.runnerId}): not started`;
      const lines = [`${name} (${s.runnerId})`];
      lines.push(`  started   ${s.runStartedAt === null ? '-' : iso(s.runStartedAt)}`);
      lines.push(
        s.finishAt === null
          ? '  finish    not finished'
          : `  finish    ${iso(s.finishAt)} (${
              s.finishBy === 'course'
                ? 'reached the course length'
                : `Stop pressed${s.shortM === null ? '' : `, ${(s.shortM / 1000).toFixed(2)} km before the course end`}: includes the delay to Stop`
            })`,
      );
      lines.push(`  elapsed   ${s.elapsedMs === null ? '-' : formatSpan(s.elapsedMs)}${s.finishAt === null ? ' (to the last fix)' : ''}`);
      lines.push(`  distance  ${(s.distanceM / 1000).toFixed(2)} km`);
      lines.push(`  avg pace  ${s.avgPaceSPerKm === null ? '-' : `${formatPace(Math.round(s.avgPaceSPerKm))} /km`}`);
      if (s.checkpoints === null) lines.push('  ETA       no course: no ETA');
      else if (s.finishAt === null) lines.push('  ETA       not finished: no ETA error');
      else if (s.checkpoints.length === 0) lines.push(`  ETA       no ETA shown at any ${CHECKPOINT_M / 1000} km checkpoint (or the course is shorter)`);
      else {
        lines.push('  ETA error at each checkpoint (ETA shown − finish; + means it predicted later):');
        for (const c of s.checkpoints) {
          lines.push(`    ${String(c.atM / 1000).padStart(3)} km  at ${iso(c.reachedAt)}  ETA ${iso(c.etaAt)}  ${signedSpan(c.errorMs)}`);
        }
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

// ---------------------------------------------------------------- loop

export type RunLogDeps = {
  fetch: typeof globalThis.fetch;
  now: () => number;
  /** Waits `ms`, resolving early when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  appendLine: (path: string, line: string) => void;
  /** True when the file exists and is not empty (an existing --out keeps its header). */
  hasContent: (path: string) => boolean;
  log: (line: string) => void;
  error: (line: string) => void;
  /** Aborted on Ctrl-C: the loop ends and summarizes what it has. */
  signal: AbortSignal;
};

export type RunLogResult = { outPath: string | null; rows: RunRow[]; snapshot: Snapshot | null };

/** "20261108T060000Z": a file-name-safe UTC stamp. */
export const fileStamp = (ms: number) => iso(ms).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

async function poll(deps: RunLogDeps, baseUrl: string): Promise<{ ok: true; snapshot: Snapshot } | { ok: false; reason: string }> {
  const url = `${baseUrl}/api/v1/snapshot`;
  let res: Response;
  try {
    res = await deps.fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), deps.signal]) });
  } catch (err) {
    const cause = (err as { cause?: { message?: string; code?: string } }).cause;
    return { ok: false, reason: `${url} unreachable: ${cause?.code ?? cause?.message ?? (err as Error).message}` };
  }
  if (res.status !== 200) return { ok: false, reason: `${url} returned ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: `${url} returned invalid JSON` };
  }
  const parsed = Snapshot.safeParse(body);
  if (!parsed.success) return { ok: false, reason: `${url} returned an unexpected snapshot` };
  return { ok: true, snapshot: parsed.data };
}

const statusLine = (snapshot: Snapshot) => {
  const names = new Map(snapshot.event.runners.map((r) => [r.runnerId, r.displayName]));
  const parts = snapshot.runners.map((v) => {
    const eta = v.etaAt === null ? '' : ` ETA ${iso(v.etaAt).slice(11, 19)}Z`;
    return `${names.get(v.runnerId) ?? v.runnerId} ${v.status} ${(v.distanceM / 1000).toFixed(2)} km${eta}`;
  });
  return `${iso(snapshot.serverNow).slice(11, 19)}Z  ${parts.join(' | ')}`;
};

/** Polls until every runner that started in this run is stopped, or until `deps.signal` aborts. */
export async function runLog(options: RunLogOptions, deps: RunLogDeps): Promise<RunLogResult> {
  const startedAt = deps.now();
  let outPath = options.outPath;
  let headerWritten = false;
  let latest: Snapshot | null = null;
  const rows: RunRow[] = [];
  const seenActive = new Set<string>();
  while (!deps.signal.aborted) {
    const result = await poll(deps, options.baseUrl);
    if (deps.signal.aborted) break;
    if (!result.ok) {
      deps.error(`${iso(deps.now())}  poll failed: ${result.reason} (retrying in ${formatSpan(options.intervalMs)})`);
    } else {
      const snapshot = result.snapshot;
      latest = snapshot;
      outPath ??= join(options.dataDir, 'run-logs', `${snapshot.event.eventId}-${fileStamp(startedAt)}.csv`);
      try {
        if (!headerWritten && !deps.hasContent(outPath)) deps.appendLine(outPath, CSV_HEADER);
        headerWritten = true;
        for (const line of snapshotRows(snapshot)) deps.appendLine(outPath, line);
      } catch (err) {
        // E.g. the CSV open in Excel (locked): keep polling, the summary still has every row.
        deps.error(`${iso(deps.now())}  cannot write ${outPath}: ${(err as Error).message.split('\n')[0]} (rows kept for the summary)`);
      }
      rows.push(...toRunRows(snapshot));
      deps.log(statusLine(snapshot));
      for (const v of snapshot.runners) if (v.status === 'active') seenActive.add(v.runnerId);
      const done =
        seenActive.size > 0 && snapshot.runners.every((v) => !seenActive.has(v.runnerId) || v.status === 'stopped');
      if (done) break;
    }
    await deps.sleep(options.intervalMs, deps.signal);
  }
  return { outPath, rows, snapshot: latest };
}

/** The summary text printed at the end, or null when no snapshot ever arrived. */
export function finalReport(result: RunLogResult): string | null {
  if (result.snapshot === null) return null;
  const { event } = result.snapshot;
  const names = new Map(event.runners.map((r) => [r.runnerId, r.displayName]));
  const length = event.lengthM === null ? 'no course' : `course ${(event.lengthM / 1000).toFixed(2)} km`;
  return [
    `run-log: ${event.eventId}, ${length}, ${result.rows.length} rows in ${result.outPath}`,
    '',
    formatRunSummary(summarizeRun(result.rows, event.hasCourse ? event.lengthM : null), names),
  ].join('\n');
}

export async function main(argv: readonly string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  let options: RunLogOptions;
  try {
    options = parseRunLogArgs(argv, env);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${USAGE}`);
    return 1;
  }
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  console.log(`run-log: polling ${options.baseUrl}/api/v1/snapshot every ${formatSpan(options.intervalMs)}; Ctrl-C to stop`);
  const result = await runLog(options, {
    fetch: globalThis.fetch,
    now: Date.now,
    sleep: (ms, signal) => delay(ms, undefined, { signal }).catch(() => undefined),
    appendLine: (path, line) => {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${line}\n`);
    },
    hasContent: (path) => existsSync(path) && statSync(path).size > 0,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    signal: controller.signal,
  });
  const report = finalReport(result);
  if (report === null) {
    console.error('run-log: no snapshot received, nothing to summarize');
    return 1;
  }
  console.log(`\n${report}`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
