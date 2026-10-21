// pnpm race-check: is the home PC race-ready (AD-14)? Checks the public health
// endpoint, that the live event is the configured one and its window is not closed,
// the runners, the course, and the Windows sleep/hibernate timeouts on AC power.
// It reads the event config JSON itself: server/scripts may not import server/src/config.
// Checks it cannot automate are in docs/ops/race-readiness.md.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { Snapshot } from '@running-live-tracker/shared';

export const REQUEST_TIMEOUT_MS = 15_000;

export const USAGE = [
  'Usage: pnpm race-check --base-url <url> [--config <event.json>]',
  '  --base-url  public server URL, e.g. https://<machine>.<tailnet>.ts.net',
  '  --config    event config the server should be running (default: EVENT_CONFIG, else config/event.json)',
].join('\n');

export class UsageError extends Error {}

export type RaceCheckOptions = { baseUrl: string; configPath: string };

export function parseRaceCheckArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  repoRoot = resolve(import.meta.dirname, '..', '..'),
): RaceCheckOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv[0] === '--' ? argv.slice(1) : [...argv],
      strict: true,
      allowPositionals: false,
      options: { 'base-url': { type: 'string' }, config: { type: 'string' } },
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  // Same EVENT_CONFIG env and default as server/src/main.ts.
  const configPath = resolve(values.config ?? env['EVENT_CONFIG'] ?? resolve(repoRoot, 'config', 'event.json'));
  return { baseUrl: parseBaseUrl(values['base-url']), configPath };
}

/** Validates a --base-url value (http(s), no query or fragment) and drops trailing slashes. */
export function parseBaseUrl(baseUrl: string | undefined): string {
  if (baseUrl === undefined) throw new UsageError('Missing --base-url');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new UsageError(`Invalid --base-url "${baseUrl}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UsageError('--base-url must be http:// or https://');
  if (url.search !== '' || url.hash !== '') throw new UsageError('--base-url must not have a query or fragment');
  return baseUrl.replace(/\/+$/, '');
}

/**
 * The AC value of a `powercfg /query <scheme> <subgroup> <setting>` block: the
 * second-to-last 0x… number (the last is DC). Labels are localized, so they are ignored.
 */
export function parsePowercfgAcIndex(output: string): number | null {
  const values = output.match(/\b0x[0-9a-f]+\b/gi) ?? [];
  if (values.length < 2) return null;
  return Number.parseInt(values[values.length - 2]!.slice(2), 16);
}

/** The part of the event config race-check needs (the server validates the whole file at boot). */
export const RaceConfig = z.object({
  eventId: z.string().min(1),
  opensAt: z.number(),
  closesAt: z.number(),
  coursePath: z.string().optional(),
  runners: z.array(z.object({ runnerId: z.string().min(1), displayName: z.string() })),
});
export type RaceConfig = z.infer<typeof RaceConfig>;

/** GET /api/v1/health body (the type lives in server/src/http, which scripts may not import). */
const HealthBody = z.object({ ok: z.literal(true), serverNow: z.number(), eventId: z.string().min(1) });

export type CheckStatus = 'PASS' | 'FAIL' | 'SKIP';
export type CheckResult = { name: string; status: CheckStatus; detail: string };
export type PowerSetting = 'STANDBYIDLE' | 'HIBERNATEIDLE';

export type RaceCheckDeps = {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  now: () => number;
  /** Reads and validates the event config; throws with a readable message. */
  readConfig: () => RaceConfig;
  /** `powercfg /query SCHEME_CURRENT SUB_SLEEP <setting>` output; null when not on Windows; throws when powercfg fails. */
  queryPower: (setting: PowerSetting) => Promise<string | null>;
};

export function readConfigFile(path: string): RaceConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read ${path}: ${(err as Error).message}`);
  }
  const parsed = RaceConfig.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
    throw new Error(`invalid config ${path} (${fields})`);
  }
  return parsed.data;
}

/** "3 d 4 h", "2 h 5 min", "12 min", "under 1 min". */
export function formatDuration(ms: number): string {
  const totalMin = Math.floor(Math.abs(ms) / 60_000);
  if (totalMin === 0) return 'under 1 min';
  const parts: [number, string][] = [
    [Math.floor(totalMin / 1440), 'd'],
    [Math.floor((totalMin % 1440) / 60), 'h'],
    [totalMin % 60, 'min'],
  ];
  const first = parts.findIndex(([n]) => n > 0);
  return parts
    .slice(first, first + 2)
    .filter(([n]) => n > 0)
    .map(([n, unit]) => `${n} ${unit}`)
    .join(' ');
}

const iso = (ms: number) => new Date(ms).toISOString();

/** GETs a JSON endpoint and validates it; returns the data or a one-line reason. */
async function getJson<T>(
  deps: RaceCheckDeps,
  path: string,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; reason: string }> {
  const url = `${deps.baseUrl}${path}`;
  let res: Response;
  try {
    res = await deps.fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    const cause = (err as { cause?: { message?: string; code?: string } }).cause;
    return { ok: false, reason: `${url} unreachable: ${cause?.code ?? cause?.message ?? (err as Error).message}` };
  }
  const text = await res.text().catch(() => '');
  if (res.status !== 200) return { ok: false, reason: `${url} answered HTTP ${res.status}` };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${url} did not return JSON` };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, reason: `${url} returned an unexpected body` };
  return { ok: true, data: parsed.data };
}

async function powerCheck(
  deps: RaceCheckDeps,
  name: string,
  setting: PowerSetting,
  fix: string,
): Promise<CheckResult> {
  let output: string | null;
  try {
    output = await deps.queryPower(setting);
  } catch (err) {
    return { name, status: 'SKIP', detail: `powercfg failed: ${(err as Error).message.split('\n')[0]}` };
  }
  if (output === null) return { name, status: 'SKIP', detail: 'not Windows' };
  const seconds = parsePowercfgAcIndex(output);
  if (seconds === null) return { name, status: 'SKIP', detail: `cannot read the AC value of SUB_SLEEP ${setting}` };
  if (seconds === 0) return { name, status: 'PASS', detail: 'never on AC power' };
  return { name, status: 'FAIL', detail: `after ${formatDuration(seconds * 1000)} on AC power; run ${fix}` };
}

export async function raceCheck(deps: RaceCheckDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const now = deps.now();

  let config: RaceConfig | null = null;
  let configError = '';
  try {
    config = deps.readConfig();
  } catch (err) {
    configError = (err as Error).message;
  }

  const health = await getJson(deps, '/api/v1/health', HealthBody);
  results.push(
    health.ok
      ? { name: 'health', status: 'PASS', detail: `${deps.baseUrl}/api/v1/health ok, server clock ${iso(health.data.serverNow)}` }
      : { name: 'health', status: 'FAIL', detail: health.reason },
  );

  if (config === null) results.push({ name: 'event', status: 'FAIL', detail: configError });
  else if (!health.ok) results.push({ name: 'event', status: 'FAIL', detail: `no health answer; expected "${config.eventId}"` });
  else if (health.data.eventId !== config.eventId)
    results.push({ name: 'event', status: 'FAIL', detail: `server runs "${health.data.eventId}", config has "${config.eventId}"` });
  else results.push({ name: 'event', status: 'PASS', detail: `"${config.eventId}" is live` });

  if (config === null) results.push({ name: 'window', status: 'FAIL', detail: 'no config' });
  else if (config.closesAt <= now)
    results.push({ name: 'window', status: 'FAIL', detail: `closed ${formatDuration(now - config.closesAt)} ago (${iso(config.closesAt)})` });
  else if (now < config.opensAt)
    results.push({
      name: 'window',
      status: 'PASS',
      detail: `opens in ${formatDuration(config.opensAt - now)} (${iso(config.opensAt)}), closes ${iso(config.closesAt)}`,
    });
  else
    results.push({
      name: 'window',
      status: 'PASS',
      detail: `open since ${iso(config.opensAt)}, closes in ${formatDuration(config.closesAt - now)} (${iso(config.closesAt)})`,
    });

  // Runners and course come from the live snapshot.
  const snapshot = health.ok ? await getJson(deps, '/api/v1/snapshot', Snapshot) : null;
  const serverProblem = snapshot === null ? 'no health answer' : snapshot.ok ? '' : snapshot.reason;

  if (config === null) results.push({ name: 'runners', status: 'FAIL', detail: 'no config' });
  else if (snapshot === null || !snapshot.ok) results.push({ name: 'runners', status: 'FAIL', detail: serverProblem });
  else {
    const live = snapshot.data.event.runners;
    const liveIds = new Set(live.map((r) => r.runnerId));
    const configIds = new Set(config.runners.map((r) => r.runnerId));
    const missing = [...configIds].filter((id) => !liveIds.has(id));
    const extra = [...liveIds].filter((id) => !configIds.has(id));
    if (missing.length === 0 && extra.length === 0 && live.length > 0) {
      const names = live.map((r) => `${r.displayName} (${r.runnerId})`).join(', ');
      results.push({ name: 'runners', status: 'PASS', detail: `${live.length}: ${names}` });
    } else if (missing.length === 0 && extra.length === 0) {
      results.push({ name: 'runners', status: 'FAIL', detail: 'no runners configured' });
    } else {
      const parts = [];
      if (missing.length > 0) parts.push(`not on the server: ${missing.join(', ')}`);
      if (extra.length > 0) parts.push(`not in the config: ${extra.join(', ')}`);
      results.push({ name: 'runners', status: 'FAIL', detail: parts.join('; ') });
    }
  }

  if (config === null) results.push({ name: 'course', status: 'FAIL', detail: 'no config' });
  else if (snapshot === null || !snapshot.ok) results.push({ name: 'course', status: 'FAIL', detail: serverProblem });
  else {
    const { hasCourse, lengthM } = snapshot.data.event;
    const expected = config.coursePath !== undefined;
    if (expected && hasCourse)
      results.push({ name: 'course', status: 'PASS', detail: `loaded, ${lengthM === null ? '?' : (lengthM / 1000).toFixed(2)} km` });
    else if (expected) results.push({ name: 'course', status: 'FAIL', detail: `config has coursePath "${config.coursePath}" but the server has no course` });
    else if (hasCourse) results.push({ name: 'course', status: 'FAIL', detail: 'the server has a course but the config has no coursePath' });
    else results.push({ name: 'course', status: 'PASS', detail: 'none configured' });
  }

  results.push(await powerCheck(deps, 'sleep', 'STANDBYIDLE', 'powercfg /change standby-timeout-ac 0'));
  results.push(await powerCheck(deps, 'hibernate', 'HIBERNATEIDLE', 'powercfg /change hibernate-timeout-ac 0'));
  return results;
}

/** Aligned report lines plus a summary line. */
export function formatReport(results: readonly CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.name.length));
  const lines = results.map((r) => `${r.status}  ${r.name.padEnd(width)}  ${r.detail}`);
  const count = (s: CheckStatus) => results.filter((r) => r.status === s).length;
  const failed = count('FAIL');
  lines.push('');
  lines.push(
    `${count('PASS')} passed, ${failed} failed, ${count('SKIP')} skipped: ${failed === 0 ? 'race-ready' : 'NOT race-ready'}`,
  );
  return lines.join('\n');
}

function queryPowercfg(setting: PowerSetting): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolvePromise, reject) => {
    execFile(
      'powercfg',
      ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP', setting],
      { encoding: 'latin1', timeout: 10_000, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolvePromise(stdout)),
    );
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  let options: RaceCheckOptions;
  try {
    options = parseRaceCheckArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${USAGE}`);
    return 1;
  }
  try {
    const results = await raceCheck({
      baseUrl: options.baseUrl,
      fetch: globalThis.fetch,
      now: Date.now,
      readConfig: () => readConfigFile(options.configPath),
      queryPower: queryPowercfg,
    });
    console.log(`race-check ${options.baseUrl} against ${options.configPath}\n`);
    console.log(formatReport(results));
    return results.some((r) => r.status === 'FAIL') ? 1 : 0;
  } catch (err) {
    console.error(`race-check failed: ${(err as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
