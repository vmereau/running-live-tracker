import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSelection, type SelectionState } from './selection.ts';

function recorded() {
  const selection = createSelection();
  const seen: SelectionState[] = [];
  selection.subscribe((state) => seen.push({ ...state }));
  return { selection, seen };
}

test('starts in the "All runners" overview', () => {
  const selection = createSelection();
  assert.deepStrictEqual(selection.get(), { selectedId: null, following: false });
});

test('select selects and follows; selecting another runner switches and keeps following', () => {
  const { selection, seen } = recorded();
  selection.select('a');
  assert.deepStrictEqual(selection.get(), { selectedId: 'a', following: true });
  selection.select('b');
  assert.deepStrictEqual(selection.get(), { selectedId: 'b', following: true });
  assert.deepStrictEqual(seen, [
    { selectedId: 'a', following: true },
    { selectedId: 'b', following: true },
  ]);
});

test('re-selecting the selected runner never deselects; it resumes following when paused', () => {
  const { selection, seen } = recorded();
  selection.select('a');
  selection.select('a');
  assert.deepStrictEqual(selection.get(), { selectedId: 'a', following: true });
  selection.pauseFollow();
  assert.deepStrictEqual(selection.get(), { selectedId: 'a', following: false });
  selection.select('a');
  assert.deepStrictEqual(selection.get(), { selectedId: 'a', following: true });
  assert.deepStrictEqual(seen, [
    { selectedId: 'a', following: true },
    { selectedId: 'a', following: false },
    { selectedId: 'a', following: true },
  ]);
});

test('pause and resume toggle following of the selected runner', () => {
  const { selection } = recorded();
  selection.select('a');
  selection.pauseFollow();
  assert.equal(selection.get().following, false);
  selection.resumeFollow();
  assert.deepStrictEqual(selection.get(), { selectedId: 'a', following: true });
});

test('pause and resume are no-ops without a selection', () => {
  const { selection, seen } = recorded();
  selection.resumeFollow();
  selection.pauseFollow();
  assert.deepStrictEqual(selection.get(), { selectedId: null, following: false });
  assert.deepStrictEqual(seen, []);
});

test('showAll clears the selection and stops following', () => {
  const { selection, seen } = recorded();
  selection.select('a');
  selection.showAll();
  assert.deepStrictEqual(selection.get(), { selectedId: null, following: false });
  selection.select('b');
  selection.pauseFollow();
  selection.showAll();
  assert.deepStrictEqual(selection.get(), { selectedId: null, following: false });
  assert.equal(seen.length, 5);
});

test('no notification when nothing changes', () => {
  const { selection, seen } = recorded();
  selection.showAll();
  selection.select('a');
  selection.select('a');
  selection.resumeFollow();
  selection.pauseFollow();
  selection.pauseFollow();
  selection.showAll();
  selection.showAll();
  assert.deepStrictEqual(seen, [
    { selectedId: 'a', following: true },
    { selectedId: 'a', following: false },
    { selectedId: null, following: false },
  ]);
});
