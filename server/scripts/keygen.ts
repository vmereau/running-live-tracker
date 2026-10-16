// pnpm keygen <runnerId>: makes a new runner key (AD-5).
// The key goes to the runner's phone only; the server config stores just its keyHash.
import { randomBytes } from 'node:crypto';
import { hashKey } from '../src/domain/hash-key.ts';

const RUNNER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type GeneratedKey = { runnerId: string; key: string; keyHash: string };

/** 32 random bytes, base64url without padding (43 chars), and its hash. */
export function generateKey(runnerId: string): GeneratedKey {
  const key = randomBytes(32).toString('base64url');
  return { runnerId, key, keyHash: hashKey(key) };
}

export function formatKeygenOutput({ runnerId, key, keyHash }: GeneratedKey): string {
  const entry = { runnerId, displayName: runnerId, color: '#e6194b', keyHash };
  return [
    `Runner key for ${runnerId} (give it to the runner's phone only, never commit it):`,
    `  key:     ${key}`,
    `  keyHash: ${keyHash}`,
    '',
    'Runner entry for config/event.json "runners" (adjust displayName and color):',
    JSON.stringify(entry, null, 2),
    '',
  ].join('\n');
}

if (import.meta.main) {
  const runnerId = process.argv[2];
  if (runnerId === undefined || !RUNNER_ID.test(runnerId)) {
    console.error('Usage: pnpm keygen <runnerId>   (runnerId: lowercase slug, e.g. alice or jean-marc)');
    process.exit(1);
  }
  process.stdout.write(formatKeygenOutput(generateKey(runnerId)));
}
