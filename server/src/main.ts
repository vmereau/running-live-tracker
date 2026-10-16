// Composition root: the only module that may import every other module.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createKeyLookup } from './config/key-lookup.ts';
import { ConfigError, loadConfig } from './config/load-config.ts';
import type { EventConfig } from './config/load-config.ts';
import { buildApp } from './http/build-app.ts';
import { createIngest } from './ingest/ingest.ts';
import { createProjection } from './projection/create-projection.ts';
import type { Projection } from './projection/create-projection.ts';
import { openStore } from './store/open-store.ts';
import type { Store } from './store/open-store.ts';

const HOST = '127.0.0.1'; // AD-11: never bind anything else, in any environment.
const repoRoot = resolve(import.meta.dirname, '..', '..');

const rawPort = process.env['PORT']?.trim() ?? '';
const port = rawPort === '' ? 8787 : /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
if (!(port >= 1 && port <= 65535)) {
  console.error(`Invalid PORT: ${process.env['PORT']}`);
  process.exit(1);
}
const dataDir = resolve(process.env['DATA_DIR'] ?? resolve(repoRoot, 'data'));
const configPath = resolve(process.env['EVENT_CONFIG'] ?? resolve(repoRoot, 'config', 'event.json'));
const webRoot = resolve(repoRoot, 'web', 'dist'); // built by `pnpm --filter web build`

let config: EventConfig;
try {
  config = loadConfig(configPath);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const dbPath = resolve(dataDir, 'tracker.db');
let store: Store;
try {
  mkdirSync(dataDir, { recursive: true });
  store = openStore(dbPath);
} catch (err) {
  console.error(`Cannot open the data store at ${dbPath}: ${(err as Error).message}`);
  process.exit(1);
}
let projection: Projection;
try {
  // Boot replay of the fix log into the in-memory projection.
  projection = createProjection({ config, store });
} catch (err) {
  console.error(`Cannot replay the data store at ${dbPath}: ${(err as Error).message}`);
  store.close();
  process.exit(1);
}
const ingest = createIngest({ store, findRunner: createKeyLookup(config), projection, now: Date.now });

// JSON logs to stdout; writing them under data/logs is Story 4.2.
const app = buildApp({ config, ingest, projection, now: Date.now, logger: true, webRoot });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  // A second signal while close() hangs forces the exit.
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  let exitCode = 0;
  try {
    await app.close();
  } catch (err) {
    app.log.error({ err }, 'failed to close the server');
    exitCode = 1;
  } finally {
    // After app.close(): no request can still be writing.
    store.close();
  }
  process.exit(exitCode);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown(signal));

try {
  await app.listen({ host: HOST, port });
  app.log.info({ eventId: config.eventId, configPath, dataDir, dbPath, webRoot }, 'server ready');
} catch (err) {
  app.log.error({ err }, 'failed to start');
  store.close();
  process.exit(1);
}
