// The board on a VPS (#1749): one poller per board however many servers point at it, and the PC's Postgres is the
// PC's alone.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.ts'; // sets CB_DATABASE_URL before the server's db client loads

const { lead } = await import('../server/main.ts');
const { sql: serverSql, connect } = await import('../server/db.ts');
const { ownsPg } = await import('../db/pg.ts');
const clients: any[] = [];
after(() => Promise.all([...clients.map((c) => c.end()), serverSql.end()]));

test('one poller: the server holding the lock polls; a second waits, and takes over when the first goes', async () => {
  clients.push(await freshDb());
  const other = connect(); clients.push(other); // another server: its own pool
  const started: string[] = [];
  const first = await lead(() => started.push('vps'), 20, serverSql);
  assert.deepEqual(started, ['vps']);
  let second: any;
  const waiting = lead(() => started.push('pc'), 20, other).then((c) => (second = c));
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(started, ['vps'], 'the PC\'s server, left running, does not poll too');
  await first`select pg_advisory_unlock_all()`; // the VPS server stops: its connection, and the lock, go
  first.release();
  await waiting;
  assert.deepEqual(started, ['vps', 'pc']);
  await second`select pg_advisory_unlock_all()`;
  second.release();
});

test('ownsPg: only this repo\'s Windows cluster on 127.0.0.1:5434 is started by the board', () => {
  const win = process.platform === 'win32';
  assert.equal(ownsPg('postgres://cb@127.0.0.1:5434/claude_board'), win);
  assert.equal(ownsPg('postgres://cb:pw@100.64.0.9:5434/claude_board'), false, 'the VPS over Tailscale');
  assert.equal(ownsPg('postgres://cb:pw@db:5432/claude_board'), false, 'the container');
  assert.equal(ownsPg('postgres://cb@localhost/claude_board'), false, 'another local Postgres on 5432');
});
