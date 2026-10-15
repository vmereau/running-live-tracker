// Composition root: the only module that may import every other module.
import { resolve } from 'node:path';
import { ConfigError, loadConfig } from './config/load-config.ts';
import type { EventConfig } from './config/load-config.ts';
import { buildApp } from './http/build-app.ts';

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

// JSON logs to stdout; writing them under data/logs is Story 4.2.
const app = buildApp({ config, now: Date.now, logger: true, webRoot });
try {
  await app.listen({ host: HOST, port });
  app.log.info({ eventId: config.eventId, configPath, dataDir, webRoot }, 'server ready');
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}
