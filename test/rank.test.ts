import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankAt } from '../web/src/lib/rank.ts';

test('rankAt places between, above and below neighbours', () => {
  const l = [{ rank: 0 }, { rank: 1024 }];
  assert.equal(rankAt([], 0), 0);
  assert.equal(rankAt(l, 0), -1024);
  assert.equal(rankAt(l, 1), 512);
  assert.equal(rankAt(l, 2), 2048);
});

test('dropIndex: same-column moves land where dnd-kit previews them', async () => {
  const { dropIndex } = await import('../web/src/lib/rank.ts');
  const col = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.equal(dropIndex(col, 1, 2, true), 1);    // A onto B, down one → [B,A,C]
  assert.equal(dropIndex(col, 1, 3, true), 2);    // A onto C → [B,C,A]
  assert.equal(dropIndex(col, 3, 1, true), 0);    // C onto A, up → [C,A,B]
  assert.equal(dropIndex(col, 2, 2, true), null); // dropped on itself: no move
  assert.equal(dropIndex(col, 9, 2, false), 1);   // from another column: before the card it's over
  assert.equal(dropIndex(col, 9, 'col:next', false), 3); // on the column itself: end
});
