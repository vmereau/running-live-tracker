import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ErrorBody, IngestAck } from '@running-live-tracker/shared';
import { generateKey } from '../scripts/keygen.ts';

const mainPath = join(import.meta.dirname, 'main.ts');
const exampleConfig = join(import.meta.dirname, '..', '..', 'config', 'event.example.json');

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
