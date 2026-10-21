import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ETA_MIN_DISTANCE_M, etaAt } from './eta.ts';
import type { EtaInput } from './eta.ts';

const base: EtaInput = { hasCourse: true, status: 'active', distanceM: 4000, lastFixAt: 1_000_000, remainingM: 6000, avgPaceSPerKm: 300 };

test('threshold is the named value', () => {
  assert.equal(ETA_MIN_DISTANCE_M, 1000);
});

test('happy path: lastFixAt + remaining × avg pace', () => {
  assert.equal(etaAt(base), 1_000_000 + 1_800_000);
});

test('null without a course, unless active, or with any input null', () => {
  assert.equal(etaAt({ ...base, hasCourse: false }), null);
  assert.equal(etaAt({ ...base, status: 'notStarted', lastFixAt: null }), null);
  assert.equal(etaAt({ ...base, status: 'notStarted' }), null);
  assert.equal(etaAt({ ...base, status: 'stopped', distanceM: 5000 }), null);
  assert.equal(etaAt({ ...base, lastFixAt: null }), null);
  assert.equal(etaAt({ ...base, remainingM: null }), null);
  assert.equal(etaAt({ ...base, avgPaceSPerKm: null }), null);
});

test('null with a negative remaining distance or a pace that is not positive', () => {
  assert.equal(etaAt({ ...base, remainingM: -1 }), null);
  assert.equal(etaAt({ ...base, remainingM: Number.NaN }), null);
  assert.equal(etaAt({ ...base, avgPaceSPerKm: 0 }), null);
  assert.equal(etaAt({ ...base, avgPaceSPerKm: -300 }), null);
  assert.equal(etaAt({ ...base, avgPaceSPerKm: Number.NaN }), null);
});

test('null below 1000 m, set from 1000 m', () => {
  assert.equal(etaAt({ ...base, distanceM: 999 }), null);
  assert.equal(etaAt({ ...base, distanceM: 999.999 }), null);
  assert.equal(etaAt({ ...base, distanceM: Number.NaN }), null);
  assert.equal(etaAt({ ...base, distanceM: 1000 }), 1_000_000 + 1_800_000);
});

test('rounded to the millisecond (contract timestamps are integers)', () => {
  assert.equal(etaAt({ ...base, remainingM: 1234.5678, avgPaceSPerKm: 301.23 }), 1_000_000 + Math.round(1234.5678 * 301.23));
  assert.ok(Number.isInteger(etaAt({ ...base, remainingM: 1234.5678, avgPaceSPerKm: 301.23 })));
});

test('at the finish while active: etaAt = lastFixAt', () => {
  assert.equal(etaAt({ ...base, distanceM: 10_000, remainingM: 0 }), 1_000_000);
});

test('a slower average pace moves the ETA later by remaining × Δpace / 1000 s', () => {
  const at300 = etaAt(base)!;
  const at330 = etaAt({ ...base, avgPaceSPerKm: 330 })!;
  assert.equal(at330 - at300, ((6000 * 30) / 1000) * 1000);
});
