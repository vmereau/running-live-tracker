import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSelection } from './selection.ts';

test('toggle selects, deselects on repeat and notifies listeners', () => {
  const selection = createSelection();
  const seen: (string | null)[] = [];
  selection.subscribe((id) => seen.push(id));
  assert.equal(selection.get(), null);
  selection.toggle('a');
  assert.equal(selection.get(), 'a');
  selection.toggle('a');
  assert.equal(selection.get(), null);
  assert.deepStrictEqual(seen, ['a', null]);
});

test('toggling another runner switches the selection', () => {
  const selection = createSelection();
  const seen: (string | null)[] = [];
  selection.subscribe((id) => seen.push(id));
  selection.toggle('a');
  selection.toggle('b');
  assert.equal(selection.get(), 'b');
  assert.deepStrictEqual(seen, ['a', 'b']);
});
