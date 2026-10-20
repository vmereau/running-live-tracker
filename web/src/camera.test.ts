import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type CameraMemory,
  FOLLOW_MIN_ZOOM,
  initialCameraMemory,
  planSelectionChange,
  planStoreChange,
  recenterVisible,
} from './camera.ts';
import type { SelectionState } from './selection.ts';

type Runner = { runnerId: string; lastPosition: { lat: number; lon: number } | null };

const A1 = { lat: 48.85, lon: 2.35 };
const A2 = { lat: 48.851, lon: 2.351 };
const B1 = { lat: 48.86, lon: 2.36 };

const overview: SelectionState = { selectedId: null, following: false };
const followA: SelectionState = { selectedId: 'a', following: true };
const pausedA: SelectionState = { selectedId: 'a', following: false };
const followB: SelectionState = { selectedId: 'b', following: true };

function runners(a: Runner['lastPosition'], b: Runner['lastPosition'] = B1): Runner[] {
  return [
    { runnerId: 'a', lastPosition: a },
    { runnerId: 'b', lastPosition: b },
  ];
}

/** Memory right after selecting `a` with a known position at a given zoom. */
function followingMemory(): CameraMemory {
  return planSelectionChange(overview, followA, runners(A1), 12, { ...initialCameraMemory(), fitted: true }).memory;
}

test('select a runner with a position: center on it at once, zooming in to at least FOLLOW_MIN_ZOOM', () => {
  const memory = { ...initialCameraMemory(), fitted: true };
  assert.deepStrictEqual(planSelectionChange(overview, followA, runners(A1), 12, memory).action, {
    kind: 'center',
    at: A1,
    zoom: FOLLOW_MIN_ZOOM,
  });
  // Already closer than the minimum: the zoom is kept.
  assert.deepStrictEqual(planSelectionChange(overview, followA, runners(A1), 17, memory).action, {
    kind: 'center',
    at: A1,
    zoom: 17,
  });
});

test('runner moves while followed: pan to the new position at the kept zoom; no move when it did not move', () => {
  const memory = followingMemory();
  const moved = planStoreChange(followA, runners(A2), 15, memory);
  assert.deepStrictEqual(moved.action, { kind: 'pan', at: A2 });
  // A track event (same position): nothing to do.
  assert.deepStrictEqual(planStoreChange(followA, runners(A2), 15, moved.memory).action, { kind: 'none' });
});

test('paused: later events never move the map', () => {
  const memory = followingMemory();
  assert.deepStrictEqual(planStoreChange(pausedA, runners(A2), 15, memory).action, { kind: 'none' });
  // Pausing itself does not move the map either.
  assert.deepStrictEqual(planSelectionChange(followA, pausedA, runners(A1), 15, memory).action, { kind: 'none' });
});

test('re-center (or re-select) while paused: follow resumes and centers at once', () => {
  const memory = followingMemory();
  const plan = planSelectionChange(pausedA, followA, runners(A2), 16, memory);
  assert.deepStrictEqual(plan.action, { kind: 'center', at: A2, zoom: 16 });
  assert.deepStrictEqual(planStoreChange(followA, runners(A2), 16, plan.memory).action, { kind: 'none' });
});

test('switching runner: center on the new one', () => {
  const memory = followingMemory();
  assert.deepStrictEqual(planSelectionChange(followA, followB, runners(A1), 15, memory).action, {
    kind: 'center',
    at: B1,
    zoom: 15,
  });
});

test('select a notStarted runner: no move, then center (with zoom) once a position arrives, then pan', () => {
  const selected = planSelectionChange(overview, followA, runners(null), 10, { ...initialCameraMemory(), fitted: true });
  assert.deepStrictEqual(selected.action, { kind: 'none' });
  assert.deepStrictEqual(planStoreChange(followA, runners(null), 10, selected.memory).action, { kind: 'none' });
  const first = planStoreChange(followA, runners(A1), 10, selected.memory);
  assert.deepStrictEqual(first.action, { kind: 'center', at: A1, zoom: FOLLOW_MIN_ZOOM });
  assert.deepStrictEqual(planStoreChange(followA, runners(A2), 15, first.memory).action, { kind: 'pan', at: A2 });
});

test('All runners: fit every runner position (not tracks); no move when none has one', () => {
  const memory = followingMemory();
  assert.deepStrictEqual(planSelectionChange(pausedA, overview, runners(A1, null), 15, memory).action, {
    kind: 'fit',
    points: [A1],
  });
  assert.deepStrictEqual(planSelectionChange(followA, overview, runners(A1), 15, memory).action, {
    kind: 'fit',
    points: [A1, B1],
  });
  assert.deepStrictEqual(planSelectionChange(followA, overview, runners(null, null), 15, memory).action, { kind: 'none' });
});

test('overview: fit on the first data with a position only, never refit on later events', () => {
  const empty = planStoreChange(overview, runners(null, null), 2, initialCameraMemory());
  assert.deepStrictEqual(empty.action, { kind: 'none' });
  assert.equal(empty.memory.fitted, false);
  const first = planStoreChange(overview, runners(A1, null), 2, empty.memory);
  assert.deepStrictEqual(first.action, { kind: 'fit', points: [A1] });
  assert.equal(first.memory.fitted, true);
  assert.deepStrictEqual(planStoreChange(overview, runners(A2), 14, first.memory).action, { kind: 'none' });
});

test('reconnect: a fresh snapshot keeps following (and keeps a pause)', () => {
  const memory = followingMemory();
  const fresh = [{ runnerId: 'b', lastPosition: B1 }, { runnerId: 'a', lastPosition: A2 }];
  assert.deepStrictEqual(planStoreChange(followA, fresh, 15, memory).action, { kind: 'pan', at: A2 });
  assert.deepStrictEqual(planStoreChange(pausedA, fresh, 15, memory).action, { kind: 'none' });
});

test('runner gone from a snapshot: back to "All runners"', () => {
  const memory = followingMemory();
  const without = [{ runnerId: 'b', lastPosition: B1 }];
  assert.deepStrictEqual(planStoreChange(followA, without, 15, memory).action, { kind: 'showAll' });
  assert.deepStrictEqual(planStoreChange(pausedA, without, 15, memory).action, { kind: 'showAll' });
});

test('Re-center is visible only when selected, paused and with a position', () => {
  assert.equal(recenterVisible(pausedA, { lastPosition: A1 }), true);
  assert.equal(recenterVisible(followA, { lastPosition: A1 }), false);
  assert.equal(recenterVisible(pausedA, { lastPosition: null }), false);
  assert.equal(recenterVisible(pausedA, undefined), false);
  assert.equal(recenterVisible(overview, undefined), false);
});
