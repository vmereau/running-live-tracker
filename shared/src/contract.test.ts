import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ZodType } from 'zod';
import {
  EndRecord,
  ErrorBody,
  EventInfo,
  FixRecord,
  IngestAck,
  IngestBatch,
  RunnerEvent,
  RunnerView,
  Snapshot,
  TrackEvent,
  TrackPoint,
} from './contract.ts';

// Fixture files are named `<schema>.<case>.json` (or `<schema>.json`); the
// `<schema>` prefix selects the schema. Android contract tests use the same rule.
const schemas: Record<string, ZodType> = {
  'fix-record': FixRecord,
  'end-record': EndRecord,
  'ingest-batch': IngestBatch,
  'ingest-ack': IngestAck,
  'error-body': ErrorBody,
  'event-info': EventInfo,
  'track-point': TrackPoint,
  'runner-view': RunnerView,
  snapshot: Snapshot,
  'runner-event': RunnerEvent,
  'track-event': TrackEvent,
};

const fixturesDir = join(import.meta.dirname, '..', 'fixtures');

function loadFixtures(kind: 'valid' | 'invalid'): { file: string; schema: ZodType; data: unknown }[] {
  const dir = join(fixturesDir, kind);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((file) => {
      const name = file.split('.')[0]!;
      const schema = schemas[name];
      if (!schema) throw new Error(`fixture ${kind}/${file}: no schema named "${name}"`);
      return { file, schema, data: JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown };
    });
}

const valid = loadFixtures('valid');
const invalid = loadFixtures('invalid');

test('every schema has at least one valid fixture', () => {
  const covered = new Set(valid.map((v) => v.file.split('.')[0]));
  for (const name of Object.keys(schemas)) assert.ok(covered.has(name), `no valid fixture for ${name}`);
});

for (const { file, schema, data } of valid) {
  test(`valid/${file} parses and round-trips unchanged`, () => {
    const result = schema.safeParse(data);
    assert.ok(result.success, result.success ? '' : JSON.stringify(result.error.issues));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result.data)), data);
  });
}

for (const { file, schema, data } of invalid) {
  test(`invalid/${file} is rejected`, () => {
    assert.equal(schema.safeParse(data).success, false);
  });
}

test('unknown keys are stripped, not rejected, outside EventInfo', () => {
  const parsed = FixRecord.parse({
    seq: 0, kind: 'fix', recordedAt: 1, lat: 0, lon: 0, accuracyM: 1, bearingDeg: 90,
  });
  assert.equal('bearingDeg' in parsed, false);
});

test('IngestBatch itself does not cap the record count (ingest returns 413)', () => {
  const records = Array.from({ length: 201 }, (_, seq) => ({ seq, kind: 'end' as const, recordedAt: seq }));
  const result = IngestBatch.safeParse({
    sessionId: '3f1c2b9e-8a4d-4c6e-9b2a-1d5e7f0a3c48', sessionStartedAt: 0, records,
  });
  assert.ok(result.success);
});
