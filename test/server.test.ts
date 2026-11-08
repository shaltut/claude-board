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

test('rpc labels array and rich options', async () => {
  await db();
  await rpc('task_add', { project: 'demo', title: 'T1', labels: ['x', 'y'] });
  const t = await (await app.request('/api/tasks/1')).json();
  assert.deepEqual(t.task.labels, ['x', 'y']);
  const res = await rpc('ask', { project: 'demo', body: 'Q?', options: [{ label: 'A', description: 'why A' }], multi: true });
  assert.equal(res.status, 200);
});

test('rpc booleans survive (blocking ask blocks task)', async () => {
  const sql = await db();
  await rpc('task_add', { project: 'demo', title: 'T1', status: 'in_progress' });
  await rpc('ask', { project: 'demo', body: 'Q?', blocking: true, task_id: 1, multi: true });
  const [t] = await sql`select status from cb.tasks where id = 1`;
  const [q] = await sql`select multi from cb.questions where id = 1`;
  assert.equal(t.status, 'blocked');
  assert.equal(q.multi, true);
});

test('GET /api/sessions lists sessions for a project', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'ihop', title => 'run', status => 'in_progress', actor => 'W6@macbook')`;
  const res = await app.request('/api/sessions?project=ihop');
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.deepEqual(rows.map((r: any) => [r.actor, r.doing.length]), [['W6@macbook', 1]]);
});

test('GET /api/huddles lists huddles; /api/huddles/:id has the thread; Today leaves huddle chatter out', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'ihop', title => 'seed')`;
  await sql`select cb.iam('pc', 'w2:p2', 'orch', 'ihop')`;
  await sql`select cb.iam('mac', 'w1:p3', 'W2@macbook', 'ihop')`;
  await sql`select cb.huddle_open('Hijri dates', ${sql.json(['W2@macbook'])}, '1', 'orch')`;
  await sql`select cb.huddle_say('1', 'indeterminate?', 'W2@macbook')`;
  const list = await (await app.request('/api/huddles?project=ihop')).json();
  assert.deepEqual(list.map((h: any) => [h.id, h.topic, h.members]), [[1, 'Hijri dates', ['orch', 'W2@macbook']]]);
  const one = await (await app.request('/api/huddles/1')).json();
  assert.deepEqual(one.lines.map((l: any) => [l.actor, l.summary]), [['orch', 'opened: Hijri dates'], ['W2@macbook', 'indeterminate?']]);
  assert.equal((await app.request('/api/huddles/99')).status, 404);
  const today = await (await app.request('/api/today?project=ihop')).json();
  assert.equal(today.events.filter((e: any) => e.kind === 'huddle').length, 0);
});
