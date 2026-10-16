import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashKey } from '../domain/hash-key.ts';
import { createKeyLookup } from './key-lookup.ts';
import type { EventConfig } from './load-config.ts';

const aliceKey = 'iPjrsCiGy9NtfNOBsf18EVex9bcFh_IiBKe7NCeXNuc';
const bobKey = 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5';

const config: EventConfig = {
  eventId: 'test-run',
  name: 'Test run',
  opensAt: 1,
  closesAt: 2,
  runners: [
    { runnerId: 'alice', displayName: 'Alice', color: '#e6194b', keyHash: hashKey(aliceKey) },
    { runnerId: 'bob', displayName: 'Bob', color: '#3cb44b', keyHash: hashKey(bobKey) },
    { runnerId: 'empty', displayName: 'Empty', color: '#3cb44b', keyHash: hashKey('') },
  ],
};

test('createKeyLookup maps each configured key to its runner', () => {
  const lookup = createKeyLookup(config);
  assert.equal(lookup(aliceKey), 'alice');
  assert.equal(lookup(bobKey), 'bob');
});

test('createKeyLookup rejects unknown, empty, wrong-length and odd input without throwing', () => {
  const lookup = createKeyLookup(config);
  for (const key of ['', 'x', aliceKey.slice(0, -1), aliceKey + 'A', aliceKey.toUpperCase(), 'é'.repeat(500), hashKey(aliceKey)]) {
    assert.equal(lookup(key), undefined, `key ${JSON.stringify(key.slice(0, 20))}`);
  }
  assert.equal(lookup(undefined as unknown as string), undefined);
});
