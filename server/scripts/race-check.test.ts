import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Snapshot } from '@running-live-tracker/shared';
import {
  UsageError,
  formatDuration,
  formatReport,
  parsePowercfgAcIndex,
  parseRaceCheckArgs,
  raceCheck,
  readConfigFile,
} from './race-check.ts';
import type { CheckResult, PowerSetting, RaceCheckDeps, RaceConfig } from './race-check.ts';

const scriptPath = join(import.meta.dirname, 'race-check.ts');
const NOW = Date.UTC(2026, 10, 8, 6, 0, 0); // 2026-11-08T06:00:00Z
const HOUR = 3_600_000;

const powercfg = (ac: string, dc = '0x00000384') => `Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)
  GUID Alias: SCHEME_BALANCED
  Subgroup GUID: 238c9fa8-0aad-41ed-83f4-97be242c8f20  (Sleep)
    GUID Alias: SUB_SLEEP
    Power Setting GUID: 29f6c1db-86da-48c5-9fdb-f2b67b1f44da  (Sleep after)
      GUID Alias: STANDBYIDLE
      Minimum Possible Setting: 0x00000000
      Maximum Possible Setting: 0xffffffff
      Possible Settings increment: 0x00000001
      Possible Settings units: Seconds
    Current AC Power Setting Index: ${ac}
    Current DC Power Setting Index: ${dc}
`;

const powercfgFr = (ac: string) => `GUID du mode de gestion de l’alimentation : 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  (Performances élevées)
  Alias de GUID : SCHEME_MIN
  GUID du sous-groupe : 238c9fa8-0aad-41ed-83f4-97be242c8f20  (Veille)
    Alias de GUID : SUB_SLEEP
    GUID du paramètre d’alimentation : 9d7815a6-7ee4-497e-8888-515a05f02364  (Mettre en veille prolongée après)
      Alias de GUID : HIBERNATEIDLE
      Valeur minimale possible : 0x00000000
      Valeur maximale possible : 0xffffffff
      Incrément possible des paramètres : 0x00000001
      Unités possibles des paramètres : secondes
    Index actuel du paramètre de courant alternatif : ${ac}
    Index actuel du paramètre de courant continu : 0x00000000
`;

const config = (over: Partial<RaceConfig> = {}): RaceConfig => ({
  eventId: 'race-2026',
  opensAt: NOW - HOUR,
  closesAt: NOW + 8 * HOUR,
  coursePath: 'courses/race.gpx',
  runners: [
    { runnerId: 'alice', displayName: 'Alice' },
    { runnerId: 'bob', displayName: 'Bob' },
  ],
  ...over,
});

const snapshot = (over: Partial<Snapshot['event']> = {}): Snapshot => ({
  serverNow: NOW,
  event: {
    eventId: 'race-2026',
    name: 'Race',
    hasCourse: true,
    lengthM: 42_195,
    runners: [
      { runnerId: 'alice', displayName: 'Alice', color: '#e6194b' },
      { runnerId: 'bob', displayName: 'Bob', color: '#3cb44b' },
    ],
    ...over,
  },
  runners: [],
  tracks: {},
});

type Route = { status: number; body: string };

/** node:http stub answering GET /api/v1/health and /api/v1/snapshot. */
async function stubServer(routes: { health?: Route; snapshot?: Route }) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const route = req.url === '/api/v1/health' ? routes.health : req.url === '/api/v1/snapshot' ? routes.snapshot : undefined;
    res.statusCode = route?.status ?? 404;
    res.setHeader('content-type', 'application/json');
    res.end(route?.body ?? '{"error":{"code":"NOT_FOUND","message":"no"}}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

const json = (body: unknown, status = 200): Route => ({ status, body: JSON.stringify(body) });
const healthy = (eventId = 'race-2026') => json({ ok: true, serverNow: NOW, eventId });

async function run(
  routes: { health?: Route; snapshot?: Route },
  over: { config?: () => RaceConfig; power?: (s: PowerSetting) => Promise<string | null>; now?: number } = {},
): Promise<Record<string, CheckResult>> {
  const stub = await stubServer(routes);
  try {
    const deps: RaceCheckDeps = {
      baseUrl: stub.baseUrl,
      fetch: globalThis.fetch,
      now: () => over.now ?? NOW,
      readConfig: over.config ?? (() => config()),
      queryPower: over.power ?? (async () => powercfg('0x00000000')),
    };
    const results = await raceCheck(deps);
    assert.deepEqual(
      results.map((r) => r.name),
      ['health', 'event', 'window', 'runners', 'course', 'sleep', 'hibernate'],
    );
    return Object.fromEntries(results.map((r) => [r.name, r]));
  } finally {
    await stub.close();
  }
}

const statuses = (r: Record<string, CheckResult>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.status]));

// ---------------------------------------------------------------- pure helpers

test('parsePowercfgAcIndex: the second-to-last 0x value, whatever the language', () => {
  assert.equal(parsePowercfgAcIndex(powercfg('0x00000000')), 0);
  assert.equal(parsePowercfgAcIndex(powercfg('0x00000708')), 1800);
  assert.equal(parsePowercfgAcIndex(powercfgFr('0x00000000')), 0);
  assert.equal(parsePowercfgAcIndex(powercfgFr('0x00000e10')), 3600);
  assert.equal(parsePowercfgAcIndex(powercfg('0x00000000').replaceAll('\n', '\r\n')), 0);
  assert.equal(parsePowercfgAcIndex(''), null);
  assert.equal(parsePowercfgAcIndex('Invalid Parameters -- try "/?" for help'), null);
  assert.equal(parsePowercfgAcIndex('only 0x1'), null);
});

test('formatDuration', () => {
  assert.equal(formatDuration(30_000), 'under 1 min');
  assert.equal(formatDuration(12 * 60_000), '12 min');
  assert.equal(formatDuration(2 * HOUR + 5 * 60_000), '2 h 5 min');
  assert.equal(formatDuration(3 * HOUR), '3 h');
  assert.equal(formatDuration(3 * 24 * HOUR + 4 * HOUR + 7 * 60_000), '3 d 4 h');
  assert.equal(formatDuration(24 * HOUR + 7 * 60_000), '1 d');
});

test('parseRaceCheckArgs: --base-url required, http(s) only; --config defaults to EVENT_CONFIG then config/event.json', () => {
  const repo = resolve('/repo');
  assert.deepEqual(parseRaceCheckArgs(['--base-url', 'https://pc.tail.ts.net/'], {}, repo), {
    baseUrl: 'https://pc.tail.ts.net',
    configPath: resolve(repo, 'config', 'event.json'),
  });
  assert.equal(parseRaceCheckArgs(['--base-url', 'http://127.0.0.1:8787'], { EVENT_CONFIG: 'x/race.json' }, repo).configPath, resolve('x/race.json'));
  assert.equal(
    parseRaceCheckArgs(['--', '--base-url', 'http://h', '--config', 'y.json'], { EVENT_CONFIG: 'x.json' }, repo).configPath,
    resolve('y.json'),
  );
  for (const bad of [
    [],
    ['--base-url'],
    ['--base-url', 'not a url'],
    ['--base-url', 'ftp://h'],
    ['--base-url', 'https://h?x=1'],
    ['--base-url', 'https://h', '--nope'],
    ['--base-url', 'https://h', 'positional'],
  ]) {
    assert.throws(() => parseRaceCheckArgs(bad, {}, repo), UsageError, bad.join(' '));
  }
});

test('readConfigFile: reads the fields it needs, names bad fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rlt-race-'));
  const good = join(dir, 'good.json');
  writeFileSync(good, JSON.stringify({ ...config(), name: 'x', runners: [{ runnerId: 'a', displayName: 'A', color: '#000000', keyHash: 'f'.repeat(64) }] }));
  assert.equal(readConfigFile(good).runners[0]!.runnerId, 'a');
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ eventId: 'x', opensAt: 'soon', runners: [] }));
  assert.throws(() => readConfigFile(bad), /opensAt.*closesAt|closesAt|opensAt/);
  assert.throws(() => readConfigFile(join(dir, 'missing.json')), /cannot read/);
});

// ---------------------------------------------------------------- raceCheck against a stub server

test('all good: every check passes with useful details', async () => {
  const r = await run({ health: healthy(), snapshot: json(snapshot()) }, { power: async (s) => (s === 'STANDBYIDLE' ? powercfg('0x00000000') : powercfgFr('0x00000000')) });
  assert.deepEqual(statuses(r), { health: 'PASS', event: 'PASS', window: 'PASS', runners: 'PASS', course: 'PASS', sleep: 'PASS', hibernate: 'PASS' });
  assert.match(r['event']!.detail, /race-2026/);
  assert.match(r['window']!.detail, /closes in 8 h/);
  assert.match(r['window']!.detail, /2026-11-08T14:00:00.000Z/);
  assert.equal(r['runners']!.detail, '2: Alice (alice), Bob (bob)');
  assert.equal(r['course']!.detail, 'loaded, 42.20 km');
  const report = formatReport(Object.values(r));
  assert.match(report, /^PASS {2}health {5}/m);
  assert.match(report, /7 passed, 0 failed, 0 skipped: race-ready/);
});

test('window not open yet passes with "opens in"', async () => {
  const r = await run({ health: healthy(), snapshot: json(snapshot()) }, { config: () => config({ opensAt: NOW + 2 * HOUR + 5 * 60_000 }) });
  assert.equal(r['window']!.status, 'PASS');
  assert.match(r['window']!.detail, /^opens in 2 h 5 min \(2026-11-08T08:05:00.000Z\)/);
});

test('window closed fails', async () => {
  const r = await run({ health: healthy(), snapshot: json(snapshot()) }, { config: () => config({ opensAt: NOW - 10 * HOUR, closesAt: NOW }) });
  assert.equal(r['window']!.status, 'FAIL');
  assert.match(r['window']!.detail, /closed/);
  assert.match(formatReport(Object.values(r)), /1 failed.*NOT race-ready/);
});

test('URL down: health fails with the reason, server checks fail, power still reported', async () => {
  const stub = await stubServer({});
  const baseUrl = stub.baseUrl;
  await stub.close(); // nothing listens there now
  const results = await raceCheck({
    baseUrl,
    fetch: globalThis.fetch,
    now: () => NOW,
    readConfig: () => config(),
    queryPower: async () => powercfg('0x00000000'),
  });
  const r = Object.fromEntries(results.map((x) => [x.name, x]));
  assert.deepEqual(statuses(r), { health: 'FAIL', event: 'FAIL', window: 'PASS', runners: 'FAIL', course: 'FAIL', sleep: 'PASS', hibernate: 'PASS' });
  assert.match(r['health']!.detail, /unreachable: ECONNREFUSED/);
});

test('non-200 and bad JSON health fail', async () => {
  let r = await run({ health: json({ error: { code: 'X', message: 'no' } }, 502) });
  assert.equal(r['health']!.status, 'FAIL');
  assert.match(r['health']!.detail, /HTTP 502/);
  assert.equal(r['runners']!.status, 'FAIL');

  r = await run({ health: { status: 200, body: '<html>tailscale</html>' } });
  assert.match(r['health']!.detail, /did not return JSON/);

  r = await run({ health: json({ ok: false }) });
  assert.match(r['health']!.detail, /unexpected body/);
});

test('snapshot failure fails runners and course only', async () => {
  const r = await run({ health: healthy(), snapshot: json({ nope: true }) });
  assert.deepEqual(statuses(r), { health: 'PASS', event: 'PASS', window: 'PASS', runners: 'FAIL', course: 'FAIL', sleep: 'PASS', hibernate: 'PASS' });
});

test('wrong event live: names both ids', async () => {
  const r = await run({ health: healthy('test-run-2026'), snapshot: json(snapshot({ eventId: 'test-run-2026' })) });
  assert.equal(r['event']!.status, 'FAIL');
  assert.match(r['event']!.detail, /test-run-2026/);
  assert.match(r['event']!.detail, /race-2026/);
});

test('unreadable config fails the config-based checks', async () => {
  const r = await run({ health: healthy(), snapshot: json(snapshot()) }, { config: () => { throw new Error('cannot read event.json: ENOENT'); } });
  assert.deepEqual(statuses(r), { health: 'PASS', event: 'FAIL', window: 'FAIL', runners: 'FAIL', course: 'FAIL', sleep: 'PASS', hibernate: 'PASS' });
  assert.match(r['event']!.detail, /ENOENT/);
});

test('runner mismatch lists both sides', async () => {
  const r = await run(
    { health: healthy(), snapshot: json(snapshot({ runners: [{ runnerId: 'alice', displayName: 'Alice', color: '#e6194b' }, { runnerId: 'carol', displayName: 'Carol', color: '#000000' }] })) },
  );
  assert.equal(r['runners']!.status, 'FAIL');
  assert.equal(r['runners']!.detail, 'not on the server: bob; not in the config: carol');
});

test('course mismatch fails both ways; no course on either side passes', async () => {
  let r = await run({ health: healthy(), snapshot: json(snapshot({ hasCourse: false, lengthM: null })) });
  assert.equal(r['course']!.status, 'FAIL');
  assert.match(r['course']!.detail, /courses\/race.gpx/);

  r = await run({ health: healthy(), snapshot: json(snapshot()) }, { config: () => config({ coursePath: undefined }) });
  assert.equal(r['course']!.status, 'FAIL');

  r = await run({ health: healthy(), snapshot: json(snapshot({ hasCourse: false, lengthM: null })) }, { config: () => config({ coursePath: undefined }) });
  assert.equal(r['course']!.status, 'PASS');
});

test('power: non-zero AC timeouts fail with the fix, French output works', async () => {
  const r = await run(
    { health: healthy(), snapshot: json(snapshot()) },
    { power: async (s) => (s === 'STANDBYIDLE' ? powercfg('0x00000708', '0x00000000') : powercfgFr('0x00000e10')) },
  );
  assert.equal(r['sleep']!.status, 'FAIL');
  assert.match(r['sleep']!.detail, /30 min on AC power.*standby-timeout-ac 0/);
  assert.equal(r['hibernate']!.status, 'FAIL');
  assert.match(r['hibernate']!.detail, /1 h on AC power.*hibernate-timeout-ac 0/);
});

test('power: not Windows or powercfg failing is SKIP and does not fail the run', async () => {
  let r = await run({ health: healthy(), snapshot: json(snapshot()) }, { power: async () => null });
  assert.deepEqual([r['sleep']!.status, r['hibernate']!.status], ['SKIP', 'SKIP']);
  assert.match(r['sleep']!.detail, /not Windows/);
  assert.match(formatReport(Object.values(r)), /5 passed, 0 failed, 2 skipped: race-ready/);

  r = await run({ health: healthy(), snapshot: json(snapshot()) }, { power: async () => { throw new Error('spawn powercfg ENOENT'); } });
  assert.equal(r['sleep']!.status, 'SKIP');
  assert.match(r['sleep']!.detail, /powercfg failed: spawn powercfg ENOENT/);

  r = await run({ health: healthy(), snapshot: json(snapshot()) }, { power: async () => 'garbage' });
  assert.equal(r['hibernate']!.status, 'SKIP');
});

// ---------------------------------------------------------------- CLI

test('race-check CLI: all good exits 0 with aligned lines', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rlt-race-cli-'));
  const configPath = join(dir, 'event.json');
  writeFileSync(configPath, JSON.stringify(config({ opensAt: Date.now() - HOUR, closesAt: Date.now() + HOUR })));
  const stub = await stubServer({ health: healthy(), snapshot: json(snapshot()) });
  try {
    const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
      // Async spawn: spawnSync would block the stub server's event loop.
      execFile(process.execPath, [scriptPath, '--base-url', stub.baseUrl, '--config', configPath], (err, stdout, stderr) =>
        done({ status: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      );
    });
    // Power is real here: a sleeping/hibernating dev PC may fail it, so only check the server-side lines.
    for (const name of ['health', 'event', 'window', 'runners', 'course']) assert.match(res.stdout, new RegExp(`^PASS  ${name}`, 'm'), res.stdout);
    assert.match(res.stdout, /passed, \d failed, \d skipped/);
    if (!/^FAIL/m.test(res.stdout)) assert.equal(res.status, 0, res.stderr);
    else assert.equal(res.status, 1);
  } finally {
    await stub.close();
  }
});

test('race-check CLI: unreachable URL exits 1 without a stack trace', () => {
  const res = spawnSync(process.execPath, [scriptPath, '--base-url', 'http://127.0.0.1:9', '--config', join(tmpdir(), 'missing-rlt.json')], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^FAIL {2}health/m);
  assert.match(res.stdout, /NOT race-ready/);
  assert.ok(!/\n\s+at /.test(res.stdout + res.stderr), res.stderr);
});

test('race-check CLI: usage errors exit 1 with the usage', () => {
  const res = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Missing --base-url/);
  assert.match(res.stderr, /Usage: pnpm race-check/);
});
