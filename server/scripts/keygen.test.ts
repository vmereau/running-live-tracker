import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { hashKey } from '../src/domain/hash-key.ts';
import { generateKey } from './keygen.ts';

const scriptPath = join(import.meta.dirname, 'keygen.ts');

test('generateKey makes a 43-char base64url key and its hashKey', () => {
  const { runnerId, key, keyHash } = generateKey('alice');
  assert.equal(runnerId, 'alice');
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(key, 'base64url').length, 32);
  assert.match(keyHash, /^[0-9a-f]{64}$/);
  assert.equal(keyHash, hashKey(key));
  assert.notEqual(generateKey('alice').key, key);
});

test('keygen CLI prints the key, its hash and a ready-to-paste runner entry', () => {
  const res = spawnSync(process.execPath, [scriptPath, 'alice'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const key = /key:\s+([A-Za-z0-9_-]+)/.exec(res.stdout)?.[1];
  const keyHash = /keyHash:\s+([0-9a-f]+)/.exec(res.stdout)?.[1];
  assert.ok(key !== undefined && keyHash !== undefined, res.stdout);
  assert.equal(key.length, 43);
  assert.equal(keyHash, hashKey(key));
  const entry = JSON.parse(res.stdout.slice(res.stdout.indexOf('{'))) as Record<string, unknown>;
  assert.deepStrictEqual(Object.keys(entry).sort(), ['color', 'displayName', 'keyHash', 'runnerId']);
  assert.equal(entry['runnerId'], 'alice');
  assert.equal(entry['keyHash'], keyHash);
  assert.ok(!JSON.stringify(entry).includes(key), 'the entry must not contain the raw key');
});

for (const args of [[], ['Alice'], ['bad id']]) {
  test(`keygen CLI rejects ${JSON.stringify(args)} with exit 1`, () => {
    const res = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Usage: pnpm keygen/);
    assert.equal(res.stdout, '');
  });
}
