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

test('bandRank: a drop only reorders among cards of the same priority', async () => {
  const { bandRank, byQueue } = await import('../web/src/lib/rank.ts');
  const col = [
    { id: 1, priority: 'P1', rank: 0 }, { id: 2, priority: 'P1', rank: 100 },
    { id: 3, priority: 'P2', rank: 50 }, { id: 4, priority: 'P2', rank: 200 },
  ];
  assert.equal(bandRank(col, 3, 'P2'), 125);       // between the two P2s
  assert.equal(bandRank(col, 0, 'P2'), 50 - 1024); // dropped above the P1s: top of the P2 band
  assert.equal(bandRank(col, 4, 'P1'), 100 + 1024); // dropped below the P2s: bottom of the P1 band
  const sorted = [col[3], col[2], col[1], col[0]].sort(byQueue).map((t) => t.id);
  assert.deepEqual(sorted, [1, 2, 3, 4]);
});
