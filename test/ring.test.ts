import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRing } from '../web/src/lib/ring.ts';

test('shouldRing: only when an id joins the waiting set, never on first load', () => {
  assert.equal(shouldRing(null, [1, 2]), false);             // first load
  assert.equal(shouldRing(new Set([1]), [1]), false);        // refetch, nothing new
  assert.equal(shouldRing(new Set([1, 2]), [1]), false);     // one answered
  assert.equal(shouldRing(new Set([1]), [1, 2]), true);      // new question
  assert.equal(shouldRing(new Set([1, 2]), [2, 3]), true);   // one answered + one new, same count
  assert.equal(shouldRing(new Set(), [7]), true);            // first question after an empty board
});
