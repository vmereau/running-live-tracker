// pnpm simulate: replays a GPX file as one or more runners through the real ingest
// API, behaving the way the phone will (AD-3): a fix every 5 s into an outbox, uploads
// of one session, oldest first, at most 200 records, delete on ack, capped backoff,
// offline gaps that hold the backlog, and a final `end` record.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ErrorBody, IngestAck, MAX_BATCH_RECORDS } from '@running-live-tracker/shared';
import type { EndRecord, FixRecord, IngestBatch } from '@running-live-tracker/shared';
import { cumulativeDistancesM, pointAtDistance } from '../src/domain/geo.ts';
import { parseGpx } from '../src/domain/gpx.ts';
import type { GpxPoint } from '../src/domain/gpx.ts';

export const FIX_INTERVAL_MS = 5_000;
export const FIX_ACCURACY_M = 5;
export const INITIAL_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_PACE_S_PER_KM = 300;
/** Tolerance (simulated ms) for floating-point time comparisons. */
const EPSILON_MS = 1e-3;

export const USAGE = [
  'Usage: pnpm simulate --base-url <url> --gpx <file> --key <k> [--key <k2> ...]',
  '                     [--pace 5:00[,5:30...]] [--time-scale N] [--stagger 30s] [--gap [i:]<at>+<duration> ...]',
  '  --base-url    server base URL, e.g. http://127.0.0.1:8787 or the public Funnel URL',
  '  --gpx         GPX file to replay (first track, or first route)',
  '  --key         runner key; repeat for more runners (one simulated runner per key)',
  '  --pace        min/km per runner in key order (default 5:00); a shorter list repeats its last value',
  '  --time-scale  simulated seconds per wall-clock second (default 1)',
  '  --stagger     runner i starts i x stagger later (simulated time, default 0)',
  '  --gap         offline gap at <at> for <duration> (simulated time since the runner started);',
  '                "i:" limits it to runner i (0-based). Repeatable. Durations: 30s, 5m, 1h (bare = seconds)',
].join('\n');

export class UsageError extends Error {}

export type Gap = { runner?: number; atMs: number; durationMs: number };

export type SimOptions = {
  baseUrl: string;
  gpxPath: string;
  keys: string[];
  /** One pace (seconds per km) per key. */
  paceSPerKm: number[];
  timeScale: number;
  staggerMs: number;
  gaps: Gap[];
};

// ---------------------------------------------------------------- argument parsing

/** "30s", "5m", "1.5h", or a bare number of seconds, to milliseconds. */
export function parseDurationMs(text: string): number {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(text.trim());
  if (m === null) throw new UsageError(`Invalid duration "${text}" (expected e.g. 30s, 5m, 1h)`);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000 }[(m[2] ?? 's') as 's' | 'm' | 'h'];
  return Math.round(Number(m[1]) * unit);
}

/** "5:00" (min:ss per km) to seconds per km. */
export function parsePace(text: string): number {
  const m = /^(\d+):([0-5]\d)$/.exec(text.trim());
  const seconds = m === null ? 0 : Number(m[1]) * 60 + Number(m[2]);
  if (seconds <= 0) throw new UsageError(`Invalid pace "${text}" (expected min:ss per km, e.g. 5:00)`);
  return seconds;
}

export function formatPace(sPerKm: number): string {
  return `${Math.floor(sPerKm / 60)}:${String(sPerKm % 60).padStart(2, '0')}`;
}

/** "[i:]<at>+<duration>". */
export function parseGap(text: string, runnerCount: number): Gap {
  const m = /^(?:(\d+):)?([^+]+)\+(.+)$/.exec(text.trim());
  if (m === null) throw new UsageError(`Invalid gap "${text}" (expected [i:]<at>+<duration>, e.g. 2m+1m or 1:2m+1m)`);
  const gap: Gap = { atMs: parseDurationMs(m[2]!), durationMs: parseDurationMs(m[3]!) };
  if (gap.durationMs <= 0) throw new UsageError(`Invalid gap "${text}": duration must be positive`);
  if (m[1] !== undefined) {
    const runner = Number(m[1]);
    if (runner >= runnerCount) throw new UsageError(`Invalid gap "${text}": there is no runner ${runner} (runners are 0..${runnerCount - 1})`);
    gap.runner = runner;
  }
  return gap;
}

export function parseSimArgs(argv: readonly string[]): SimOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv[0] === '--' ? argv.slice(1) : [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        'base-url': { type: 'string' },
        gpx: { type: 'string' },
        key: { type: 'string', multiple: true },
        pace: { type: 'string' },
        'time-scale': { type: 'string' },
        stagger: { type: 'string' },
        gap: { type: 'string', multiple: true },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const { values } = parsed;

  const baseUrl = values['base-url'];
  if (baseUrl === undefined) throw new UsageError('Missing --base-url');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new UsageError(`Invalid --base-url "${baseUrl}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UsageError('--base-url must be http:// or https://');

  const gpxPath = values.gpx;
  if (gpxPath === undefined) throw new UsageError('Missing --gpx');
  const keys = values.key ?? [];
  if (keys.length === 0) throw new UsageError('Missing --key (one per simulated runner)');
  if (keys.some((k) => k.trim() === '')) throw new UsageError('Empty --key');

  const paceList = values.pace === undefined ? [DEFAULT_PACE_S_PER_KM] : values.pace.split(',').map(parsePace);
  const paceSPerKm = keys.map((_, i) => paceList[Math.min(i, paceList.length - 1)]!);

  const timeScale = values['time-scale'] === undefined ? 1 : Number(values['time-scale']);
  if (!Number.isFinite(timeScale) || timeScale <= 0) throw new UsageError(`Invalid --time-scale "${values['time-scale']}" (expected a positive number)`);

  const staggerMs = values.stagger === undefined ? 0 : parseDurationMs(values.stagger);
  const gaps = (values.gap ?? []).map((g) => parseGap(g, keys.length));

  return { baseUrl: baseUrl.replace(/\/+$/, ''), gpxPath, keys, paceSPerKm, timeScale, staggerMs, gaps };
}

// ---------------------------------------------------------------- run plan

export type PlannedFix = { atMs: number; lat: number; lon: number; altitudeM?: number };
export type RunPlan = { lengthM: number; speedMps: number; finishMs: number; fixes: PlannedFix[] };

/**
 * Where the runner is every 5 s of simulated run time at a constant pace, from the
 * first point (t = 0) to the last (t = finishMs, with one extra fix there when the
 * finish does not fall on the 5 s grid).
 */
export function planRun(points: readonly GpxPoint[], paceSPerKm: number): RunPlan {
  if (points.length === 0) throw new Error('The GPX has no track or route points');
  const cumulative = cumulativeDistancesM(points);
  const lengthM = cumulative[cumulative.length - 1]!;
  const speedMps = 1000 / paceSPerKm;
  // pace in s/km is also ms per metre.
  const finishMs = Math.round(lengthM * paceSPerKm);
  const fixes: PlannedFix[] = [];
  // The fix at finishMs is exactly the last point, whatever the rounding of finishMs.
  const at = (atMs: number) => ({
    atMs,
    ...pointAtDistance(points, cumulative, atMs >= finishMs ? lengthM : (atMs / 1000) * speedMps),
  });
  for (let t = 0; t <= finishMs; t += FIX_INTERVAL_MS) fixes.push(at(t));
  if (fixes[fixes.length - 1]!.atMs < finishMs) fixes.push(at(finishMs));
  return { lengthM, speedMps, finishMs, fixes };
}

/** Retry delay after `failures` consecutive failures (1 = first): 1 s, 2 s, 4 s ... capped at 60 s. */
export function backoffMs(failures: number): number {
  return Math.min(INITIAL_BACKOFF_MS * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);
}

// ---------------------------------------------------------------- simulation

export type SimDeps = {
  /** Wall clock, epoch ms. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  fetch: typeof fetch;
  log: (line: string) => void;
  newSessionId?: () => string;
};

export type RunnerResult = {
  runner: number;
  sessionId: string;
  sessionStartedAt: number;
  recordCount: number;
  droppedCount: number;
  /** Every record was acked (none dropped). */
  allAcked: boolean;
};

export type SimResult = { allAcked: boolean; runners: RunnerResult[] };

type OutboxRecord = FixRecord | EndRecord;

export async function simulate(options: SimOptions & { points: readonly GpxPoint[] }, deps: SimDeps): Promise<SimResult> {
  const runners = await Promise.all(options.keys.map((key, i) => runRunner(i, key, options, deps)));
  return { allAcked: runners.every((r) => r.allAcked), runners };
}

async function runRunner(
  index: number,
  key: string,
  options: SimOptions & { points: readonly GpxPoint[] },
  deps: SimDeps,
): Promise<RunnerResult> {
  const { timeScale } = options;
  const pace = options.paceSPerKm[index]!;
  const plan = planRun(options.points, pace);
  const gaps = options.gaps
    .filter((g) => g.runner === undefined || g.runner === index)
    .map((g) => ({ startMs: g.atMs, endMs: g.atMs + g.durationMs }));
  const hasAltitude = options.points.some((p) => p.altitudeM !== undefined);
  const url = `${options.baseUrl}/api/v1/ingest`;
  const log = (msg: string) => deps.log(`[runner ${index}] ${msg}`);

  const startDelay = (index * options.staggerMs) / timeScale;
  if (startDelay > 0) await deps.sleep(Math.ceil(startDelay));

  const sessionStartedAt = deps.now();
  const sessionId = (deps.newSessionId ?? randomUUID)();
  const wallAt = (simMs: number) => sessionStartedAt + simMs / timeScale;
  const simElapsed = () => (deps.now() - sessionStartedAt) * timeScale;
  log(
    `session ${sessionId}: ${Math.round(plan.lengthM)} m at ${formatPace(pace)}/km (${plan.speedMps.toFixed(2)} m/s), ` +
      `${plan.fixes.length} fixes then end, ${gaps.length} offline gap(s)`,
  );

  const outbox: OutboxRecord[] = [];
  let nextSeq = 0;
  let nextFix = 0;
  let ended = false;
  let failures = 0;
  let retryAt = -Infinity;
  let droppedCount = 0;
  let wasOffline = false;

  const recordDue = () => {
    const elapsed = simElapsed() + EPSILON_MS;
    while (nextFix < plan.fixes.length && plan.fixes[nextFix]!.atMs <= elapsed) {
      const f = plan.fixes[nextFix++]!;
      const fix: FixRecord = {
        seq: nextSeq++,
        kind: 'fix',
        recordedAt: Math.round(sessionStartedAt + f.atMs),
        lat: f.lat,
        lon: f.lon,
        accuracyM: FIX_ACCURACY_M,
        speedMps: plan.speedMps,
      };
      if (hasAltitude && f.altitudeM !== undefined) fix.altitudeM = f.altitudeM;
      outbox.push(fix);
    }
    if (!ended && nextFix === plan.fixes.length && plan.finishMs <= elapsed) {
      outbox.push({ seq: nextSeq++, kind: 'end', recordedAt: Math.round(sessionStartedAt + plan.finishMs) });
      ended = true;
    }
  };

  /** End (simulated ms) of the gap the runner is in now; undefined when online. A gap ends at the finish. */
  const offlineUntil = (): number | undefined => {
    if (ended) return undefined;
    const elapsed = simElapsed() + EPSILON_MS;
    return gaps.find((g) => g.startMs <= elapsed && elapsed < g.endMs)?.endMs;
  };

  const fail = (reason: string) => {
    failures++;
    const delay = backoffMs(failures);
    retryAt = deps.now() + delay;
    log(`upload failed (${reason}), retry ${failures} in ${delay / 1000} s`);
  };

  const upload = async () => {
    const records = outbox.slice(0, MAX_BATCH_RECORDS);
    const first = records[0]!.seq;
    const last = records[records.length - 1]!.seq;
    const batch: IngestBatch = { sessionId, sessionStartedAt, records };
    let res: Response;
    try {
      res = await deps.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      fail(`network error: ${(err as Error).message}`);
      return;
    }
    const text = await res.text().catch(() => '');
    if (res.ok) {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      const ack = IngestAck.safeParse(body);
      if (!ack.success || ack.data.sessionId !== sessionId || ack.data.ackedThroughSeq < first) {
        fail(`HTTP ${res.status} with an unexpected ack`);
        return;
      }
      let removed = 0;
      while (outbox.length > 0 && outbox[0]!.seq <= ack.data.ackedThroughSeq) {
        outbox.shift();
        removed++;
      }
      failures = 0;
      retryAt = -Infinity;
      log(`posted seq ${first}..${last} (${records.length} records), acked through ${ack.data.ackedThroughSeq}, ${removed} removed`);
      return;
    }
    if (res.status === 401 || res.status === 429 || res.status >= 500) {
      fail(`HTTP ${res.status}${errorCode(text)}`);
      return;
    }
    // 400 / 409 / 413 (and any other client error): resending it would fail again.
    outbox.splice(0, records.length);
    droppedCount += records.length;
    failures = 0;
    retryAt = -Infinity;
    log(`batch seq ${first}..${last} (${records.length} records) rejected with HTTP ${res.status}${errorCode(text)}, dropped`);
  };

  for (;;) {
    recordDue();
    if (ended && outbox.length === 0) break;
    const gapEnd = offlineUntil();
    if (gapEnd !== undefined && !wasOffline) log(`offline until ${gapEnd / 1000} s of run time`);
    if (gapEnd === undefined && wasOffline) log(`back online with ${outbox.length} records to upload`);
    wasOffline = gapEnd !== undefined;
    const now = deps.now();
    if (outbox.length > 0 && gapEnd === undefined && now >= retryAt) {
      await upload();
      continue;
    }
    let wake = Infinity;
    if (!ended) wake = wallAt(nextFix < plan.fixes.length ? plan.fixes[nextFix]!.atMs : plan.finishMs);
    if (gapEnd !== undefined) wake = Math.min(wake, wallAt(gapEnd));
    else if (outbox.length > 0) wake = Math.min(wake, retryAt);
    await deps.sleep(Math.max(0, Math.ceil(wake - now)));
  }

  const recordCount = nextSeq;
  log(
    droppedCount === 0
      ? `done: all ${recordCount} records acked`
      : `done: ${recordCount - droppedCount} of ${recordCount} records acked, ${droppedCount} dropped`,
  );
  return { runner: index, sessionId, sessionStartedAt, recordCount, droppedCount, allAcked: droppedCount === 0 };
}

function errorCode(text: string): string {
  try {
    const parsed = ErrorBody.safeParse(JSON.parse(text));
    return parsed.success ? ` ${parsed.data.error.code}` : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- CLI

export async function main(argv: readonly string[]): Promise<number> {
  let options: SimOptions;
  let points: GpxPoint[];
  try {
    options = parseSimArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${USAGE}`);
    return 1;
  }
  try {
    points = parseGpx(readFileSync(options.gpxPath, 'utf8'));
  } catch (err) {
    console.error(`Cannot read GPX ${options.gpxPath}: ${(err as Error).message}`);
    return 1;
  }
  if (points.length === 0) {
    console.error(`GPX ${options.gpxPath} has no track or route points`);
    return 1;
  }
  const result = await simulate(
    { ...options, points },
    {
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      fetch: globalThis.fetch,
      log: (line) => console.log(line),
    },
  );
  console.log(result.allAcked ? 'simulation done: every record acked' : 'simulation done: some records were dropped');
  return result.allAcked ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
