import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.ts'; // sets CB_DATABASE_URL before the server's db client loads

const { app } = await import('../server/main.ts');
const { sql: serverSql } = await import('../server/db.ts');

const clients: any[] = [];
after(() => Promise.all([...clients.map((c) => c.end()), serverSql.end()]));
async function db() { const s = await freshDb(); clients.push(s); return s; }

const rpc = (fn: string, args: object) =>
  app.request(`/api/rpc/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });

test('rpc task_add returns id', async () => {
  await db();
  const res = await rpc('task_add', { project: 'demo', title: 'T1', labels: ['a'], links: { pr: '#1' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, result: 1 });
});

test('rpc error is 400 with message', async () => {
  await db();
  await rpc('task_add', { project: 'demo', title: 'T1' });
  const res = await rpc('task_move', { id: '1', status: 'nope' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /use one of/);
});

test('unknown rpc is 404 listing functions', async () => {
  const res = await rpc('drop_everything', {});
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /available: task_add/);
});

test('task detail has history', async () => {
  await db();
  await rpc('task_add', { project: 'demo', title: 'T1' });
  await rpc('task_move', { id: '1', status: 'next' });
  const res = await app.request('/api/tasks/1');
  const body = await res.json();
  assert.equal(body.task.title, 'T1');
  assert.equal(body.events.length, 2);
});

test('today counts', async () => {
  await db();
  await rpc('task_add', { project: 'demo', title: 'A', status: 'done' });
  await rpc('task_add', { project: 'demo', title: 'B', status: 'in_progress' });
  const since = new Date(Date.now() - 60_000).toISOString();
  const body = await (await app.request(`/api/today?since=${encodeURIComponent(since)}`)).json();
  assert.deepEqual(body.counts, { done: 1, active: 1, blocked: 0 });
  assert.equal(body.events.length, 2);
});

test('set-returning rpc gives an array', async () => {
  await db();
  await rpc('task_add', { project: 'demo', title: 'A', status: 'next' });
  const body = await (await rpc('task_claim', { project: 'demo', actor: 'W1' })).json();
  assert.equal(body.result.length, 1);
  assert.equal(body.result[0].assignee, 'W1');
});
