import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageMs, formatAge, statusLabel } from './format.ts';

test('formats ages as seconds below a minute and floored minutes above', () => {
  assert.equal(formatAge(0), '0 s ago');
  assert.equal(formatAge(59_999), '59 s ago');
  assert.equal(formatAge(60_000), '1 min ago');
  assert.equal(formatAge(119_999), '1 min ago');
  assert.equal(formatAge(3_600_000), '60 min ago');
});

test('no received data reads "no data yet"', () => {
  assert.equal(ageMs(null, 1000), null);
  assert.equal(formatAge(null), 'no data yet');
});

test('age is measured against the given (server-aligned) now and never negative', () => {
  assert.equal(ageMs(1000, 6000), 5000);
  assert.equal(ageMs(9000, 6000), 0);
  assert.equal(formatAge(ageMs(9000, 6000)), '0 s ago');
});

test('status labels', () => {
  assert.equal(statusLabel('notStarted'), 'not started');
  assert.equal(statusLabel('active'), 'running');
  assert.equal(statusLabel('stopped'), 'stopped');
});
