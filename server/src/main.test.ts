import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mainPath = join(import.meta.dirname, 'main.ts');
const exampleConfig = join(import.meta.dirname, '..', '..', 'config', 'event.example.json');

function startMain(env: Record<string, string>) {
  return spawn(process.execPath, [mainPath], {
    env: { ...process.env, EVENT_CONFIG: exampleConfig, ...env },
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

test('boots with the example config and listens on 127.0.0.1 only', async () => {
  const port = await freePort();
  const child = startMain({ PORT: String(port) });
  try {
    const logs: Record<string, unknown>[] = [];
    let buffer = '';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for "server ready"')), 10_000);
      child.on('exit', (code) => reject(new Error(`server exited early with code ${code}`)));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
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
