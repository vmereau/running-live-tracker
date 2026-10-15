import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig } from './load-config.ts';

const dir = mkdtempSync(join(tmpdir(), 'rlt-config-'));
const hash = (c: string) => c.repeat(64);

function validConfig() {
  return {
    eventId: 'test-run',
    name: 'Test run',
    opensAt: 1_760_000_000_000,
    closesAt: 1_760_100_000_000,
    runners: [
      { runnerId: 'alice', displayName: 'Alice', color: '#E6194B', keyHash: hash('a') },
      { runnerId: 'bob', displayName: 'Bob', color: '#3cb44b', keyHash: hash('b') },
    ],
  };
}

let n = 0;
function write(content: unknown): string {
  const path = join(dir, `event-${n++}.json`);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

function assertConfigError(path: string, ...fragments: string[]) {
  assert.throws(
    () => loadConfig(path),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError, `expected ConfigError, got ${String(err)}`);
      for (const f of fragments) assert.ok(err.message.includes(f), `message should contain "${f}":\n${err.message}`);
      return true;
    },
  );
}

test('loads a valid config, with optional coursePath', () => {
  const cfg = validConfig();
  assert.deepStrictEqual(loadConfig(write(cfg)), cfg);
  const withCourse = { ...cfg, coursePath: 'courses/race.gpx' };
  assert.equal(loadConfig(write(withCourse)).coursePath, 'courses/race.gpx');
});

test('loads a config saved with a UTF-8 BOM', () => {
  const cfg = validConfig();
  assert.deepStrictEqual(loadConfig(write('﻿' + JSON.stringify(cfg))), cfg);
});

test('loads config/event.example.json', () => {
  const cfg = loadConfig(join(import.meta.dirname, '..', '..', '..', 'config', 'event.example.json'));
  assert.equal(cfg.eventId, 'example');
});

test('rejects an uppercase keyHash, naming the field path', () => {
  const cfg = validConfig();
  cfg.runners[1]!.keyHash = hash('A');
  assertConfigError(write(cfg), 'runners.1.keyHash');
});

test('rejects a 63-char keyHash', () => {
  const cfg = validConfig();
  cfg.runners[0]!.keyHash = 'a'.repeat(63);
  assertConfigError(write(cfg), 'runners.0.keyHash');
});

test('rejects duplicate runnerId', () => {
  const cfg = validConfig();
  cfg.runners[1]!.runnerId = 'alice';
  assertConfigError(write(cfg), 'runners.1.runnerId', 'duplicate runnerId');
});

test('rejects duplicate keyHash', () => {
  const cfg = validConfig();
  cfg.runners[1]!.keyHash = hash('a');
  assertConfigError(write(cfg), 'runners.1.keyHash', 'duplicate keyHash');
});

for (const color of ['red', '#abc', '#12345g']) {
  test(`rejects color ${JSON.stringify(color)}`, () => {
    const cfg = validConfig();
    cfg.runners[0]!.color = color;
    assertConfigError(write(cfg), 'runners.0.color');
  });
}

test('rejects a non-slug runnerId and eventId', () => {
  const cfg = { ...validConfig(), eventId: 'Test Run' };
  cfg.runners[0]!.runnerId = 'Alice_1';
  assertConfigError(write(cfg), 'eventId', 'runners.0.runnerId');
});

test('rejects opensAt >= closesAt', () => {
  assertConfigError(write({ ...validConfig(), closesAt: 1_760_000_000_000 }), 'closesAt');
  assertConfigError(write({ ...validConfig(), closesAt: 1_700_000_000_000 }), 'closesAt');
});

test('rejects a missing file, naming the path', () => {
  const path = join(dir, 'does-not-exist.json');
  assertConfigError(path, path);
});

test('rejects unparseable JSON, naming the path', () => {
  const path = write('{ "eventId": ');
  assertConfigError(path, path, 'not valid JSON');
});
