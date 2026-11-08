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
