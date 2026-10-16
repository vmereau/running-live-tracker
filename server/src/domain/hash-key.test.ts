import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashKey } from './hash-key.ts';

test('hashKey matches known SHA-256 vectors as lowercase hex', () => {
  assert.equal(hashKey('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(hashKey(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('hashKey hashes UTF-8 bytes', () => {
  // SHA-256 of the UTF-8 encoding of "é" (0xc3 0xa9).
  assert.equal(hashKey('é'), '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c');
});
