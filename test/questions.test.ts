import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; }

async function blockedTask(sql: any) {
  await sql`select cb.task_add(project => 'demo', title => 'T1', status => 'in_progress')`;
  const [{ q }] = await sql`
    select cb.ask(project => 'demo', body => 'Rotate?', options => ${sql.json(['now', 'friday'])}, blocking => true,
                  task_id => '1', reply_to => ${sql.json({ machine: 'shaltoot', pane: 'p3' })}, actor => 'W1') as q`;
  return Number(q);
}

test('blocking ask blocks task', async () => {
  const sql = await db();
  const q = await blockedTask(sql);
  const [t] = await sql`select * from cb.tasks where id = 1`;
  assert.equal(t.status, 'blocked');
  assert.equal(Number(t.blocked_on), q);
  const [e] = await sql`select * from cb.events where kind = 'asked'`;
  assert.equal(e.actor, 'W1');
  assert.equal(Number(e.question_id), q);
});

test('answer is editable until delivered; after that only from the dashboard (#1346)', async () => {
  const sql = await db();
  const q = await blockedTask(sql);
  await sql`select cb.answer(${String(q)}, 'now')`;
  await sql`select cb.answer(${String(q)}, 'friday')`;
  const [row] = await sql`select * from cb.questions where id = ${q}`;
  assert.equal(row.answer, 'friday');
  assert.equal(row.status, 'answered');
  await sql`select cb.answer_delivered(${String(q)}, 'W1')`;
  const session = postgres(TEST_URL, { onnotice: () => {} }); // a session: not the dashboard
  try { await assert.rejects(session`select cb.answer(${String(q)}, 'again', 'W1')`, /already delivered/); } finally { await session.end(); }
});

test('pending then delivered unblocks', async () => {
  const sql = await db();
  const q = await blockedTask(sql);
  await sql`select cb.answer(${String(q)}, 'now')`;
  const pending = await sql`select * from cb.answers_pending()`;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].reply_to.pane, 'p3');
  await sql`select cb.answer_delivered(${String(q)}, 'W1')`;
  const [row] = await sql`select * from cb.questions where id = ${q}`;
  assert.equal(row.status, 'delivered');
  const [t] = await sql`select * from cb.tasks where id = 1`;
  assert.equal(t.status, 'in_progress'); // its assignee keeps it (review #5)
  assert.equal(t.blocked_on, null);
  assert.equal((await sql`select * from cb.answers_pending()`).length, 0);
});

test('delivered is idempotent', async () => {
  const sql = await db();
  const q = await blockedTask(sql);
  await sql`select cb.answer(${String(q)}, 'now')`;
  await sql`select cb.answer_delivered(${String(q)}, 'W1')`;
  await sql`select cb.answer_delivered(${String(q)}, 'W1')`;
  const [{ n }] = await sql`select count(*)::int n from cb.events where kind = 'delivered'`;
  assert.equal(n, 1);
});

test('brief shape', async () => {
  const sql = await db();
  await blockedTask(sql);
  const [{ b }] = await sql`select cb.brief('demo') as b`;
  for (const k of ['in_progress', 'next', 'blocked', 'open_questions', 'answered_pending'])
    assert.ok(Array.isArray(b[k]), k);
  assert.equal(b.blocked.length, 1);
  assert.equal(b.open_questions.length, 1);
});

test('last_seen default and set', async () => {
  const sql = await db();
  const [{ d }] = await sql`select extract(epoch from now() - interval '24 hours' - cb.last_seen()) as d`;
  assert.ok(Math.abs(Number(d)) < 60);
  await sql`select cb.seen('2026-01-01T00:00:00Z')`;
  const [{ at }] = await sql`select cb.last_seen() as at`;
  assert.equal(new Date(at).toISOString(), '2026-01-01T00:00:00.000Z');
});

test('ask options with descriptions', async () => {
  const sql = await db();
  const opts = [{ label: 'Rotate now (Recommended)', description: 'Before Friday cutover' }, 'Wait'];
  const [{ q }] = await sql`select cb.ask(project => 'demo', body => 'Rotate?', options => ${sql.json(opts)}) as q`;
  const [row] = await sql`select options, multi from cb.questions where id = ${q}`;
  assert.deepEqual(row.options, [
    { label: 'Rotate now (Recommended)', description: 'Before Friday cutover' },
    { label: 'Wait', description: null },
  ]);
  assert.equal(row.multi, false);
});

test('multi flag stored', async () => {
  const sql = await db();
  const [{ q }] = await sql`select cb.ask(project => 'demo', body => 'Which?', options => ${sql.json(['a', 'b'])}, multi => true) as q`;
  const [row] = await sql`select multi from cb.questions where id = ${q}`;
  assert.equal(row.multi, true);
});

test('delivered answer gives the task back to its assignee, not to Next', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'T1', status => 'next')`;
  await sql`select * from cb.task_claim('demo', 'W1')`;
  await sql`select cb.ask(project => 'demo', body => 'q?', blocking => true, task_id => '1', actor => 'W1')`;
  await sql`select cb.answer('1', 'yes')`;
  await sql`select cb.answer_delivered('1', 'W1')`;
  const [t] = await sql`select status, assignee from cb.tasks where id = 1`;
  assert.deepEqual({ ...t }, { status: 'in_progress', assignee: 'W1' });
  assert.equal((await sql`select * from cb.task_claim('demo', 'W2')`).length, 0);
});

test('read paths normalize project like writes and reject unknown projects', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'Demo API', title => 'one', status => 'next')`;
  const [{ b }] = await sql`select cb.brief('Demo API') as b`;
  assert.equal(b.next.length, 1);
  assert.equal((await sql`select * from cb.answers_pending('Demo API')`).length, 0);
  await assert.rejects(sql`select cb.brief('ihpo')`, /unknown project "ihpo"; known: demo-api/);
  await assert.rejects(sql`select * from cb.task_claim('ihpo', 'W1')`, /unknown project "ihpo"/);
  const [c] = await sql`select * from cb.task_claim('Demo API', 'W1')`;
  assert.equal(c.title, 'one');
});
