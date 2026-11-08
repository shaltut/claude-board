import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { freshDb } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; }

test('setup twice keeps rows', async () => {
  const sql = await db();
  await sql`insert into cb.projects(slug, name) values ('demo','Demo')`;
  execFileSync('node', ['db/setup.ts', '--test'], { stdio: 'pipe' });
  const [r] = await sql`select count(*)::int n from cb.projects`;
  assert.equal(r.n, 1);
});

const events = (sql: any) => sql`select * from cb.events order by id`;

test('add creates project and history', async () => {
  const sql = await db();
  const [{ id }] = await sql`select cb.task_add(project => 'Demo', title => 'T1', actor => 'W1@mac') as id`;
  assert.equal(Number(id), 1);
  const [p] = await sql`select slug from cb.projects`;
  assert.equal(p.slug, 'demo');
  const ev = await events(sql);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'task_created');
  assert.equal(ev[0].actor, 'W1@mac');
});

test('aliases', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'T1', priority => 'p1')`;
  await sql`select cb.task_move('#1', 'WIP')`;
  let [t] = await sql`select * from cb.tasks where id = 1`;
  assert.equal(t.status, 'in_progress');
  assert.equal(t.priority, 'P1');
  await sql`select cb.task_move('1', ' Done ')`;
  [t] = await sql`select * from cb.tasks where id = 1`;
  assert.equal(t.status, 'done');
  assert.ok(t.done_at);
});

test('bad status message', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'T1')`;
  await assert.rejects(sql`select cb.task_move('1', 'nope')`, /use one of backlog, next/);
});

test('moved event carries note', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'T1', status => 'in_progress')`;
  await sql`select cb.task_move('1', 'review', 'opened PR #9')`;
  const ev = await events(sql);
  const last = ev.at(-1);
  assert.equal(last.kind, 'moved');
  assert.equal(last.summary, 'opened PR #9');
  assert.equal(last.data.from, 'in_progress');
});

test('done with links', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'T1')`;
  await sql`select cb.task_done('1', 'merged', ${sql.json({ pr: '#9' })})`;
  const last = (await events(sql)).at(-1);
  assert.equal(last.kind, 'done');
  assert.equal(last.summary, 'merged');
  assert.equal(last.data.links.pr, '#9');
});

test('rank-only update is silent', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'T1')`;
  await sql`select cb.task_update('1', ${sql.json({ rank: 5 })})`;
  assert.equal((await events(sql)).length, 1);
  await sql`select cb.task_update('1', ${sql.json({ title: 'x' })})`;
  const ev = await events(sql);
  assert.equal(ev.length, 2);
  assert.equal(ev[1].kind, 'updated');
});

test('P0 jumps to top of next', async () => {
  const sql = await db();
  for (const [title, priority] of [['A', 'P2'], ['B', 'P2'], ['C', 'P0']])
    await sql`select cb.task_add(project => 'demo', title => ${title}, status => 'next', priority => ${priority})`;
  const rows = await sql`select title from cb.tasks where status = 'next' order by rank`;
  assert.deepEqual(rows.map((r: any) => r.title), ['C', 'A', 'B']);
});

test('claim takes top of next', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'A', status => 'next')`;
  await sql`select cb.task_add(project => 'demo', title => 'C', status => 'next', priority => 'P0')`;
  const [t] = await sql`select * from cb.task_claim('demo', 'W1')`;
  assert.equal(t.title, 'C');
  assert.equal(t.status, 'in_progress');
  assert.equal(t.assignee, 'W1');
  const none = await sql`select * from cb.task_claim('other', 'W1')`;
  assert.equal(none.length, 0);
});

test('claim is exclusive', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'only', status => 'next')`;
  const { TEST_URL } = await import('./helpers.ts');
  const postgres = (await import('postgres')).default;
  const a = postgres(TEST_URL, { max: 1 }), b = postgres(TEST_URL, { max: 1 });
  clients.push(a, b);
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const first = a.begin(async (tx: any) => { const r = await tx`select * from cb.task_claim('demo','Wa')`; await hold; return r; });
  await new Promise((r) => setTimeout(r, 100));
  const second = await b`select * from cb.task_claim('demo','Wb')`;
  release();
  const got = await first;
  assert.equal(got.length + second.length, 1);
});

test('mine sees cancellation once', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'A', status => 'next')`;
  await sql`select * from cb.task_claim('demo', 'W1')`;
  await sql`select cb.task_move('1', 'cancelled', actor => 'ahmed')`;
  const rows = await sql`select * from cb.mine('W1')`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'cancelled');
});

test('bookkeeping columns are not edits', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'T1')`;
  await sql`update cb.tasks set created_at = now() - interval '1 day', created_by = 'x' where id = 1`;
  assert.equal((await events(sql)).length, 1);
});

test('explicit updated_at is kept', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'T1')`;
  await sql`update cb.tasks set created_at = '2026-01-01T12:00:00Z', updated_at = '2026-01-02T12:00:00Z' where id = 1`;
  const [t] = await sql`select updated_at from cb.tasks where id = 1`;
  assert.equal(new Date(t.updated_at).toISOString().slice(0, 10), '2026-01-02');
});

test('adding in_progress work assigns it to the actor', async () => {
  const sql = await db();
  const [{ id }] = await sql`select cb.task_add(project => 'demo', title => 'in hand', status => 'in_progress', actor => 'W1@mac') as id`;
  const [{ id: other }] = await sql`select cb.task_add(project => 'demo', title => 'queued', status => 'next', actor => 'W1@mac') as id`;
  const mine = await sql`select id from cb.mine('W1@mac')`;
  assert.deepEqual(mine.map((r: any) => Number(r.id)), [Number(id)]);
  const [t] = await sql`select assignee from cb.tasks where id = ${other}`;
  assert.equal(t.assignee, null);
});
