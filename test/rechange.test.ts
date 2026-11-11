// Changing a delivered answer (#1346): a correction. The old answer is kept, the question goes back to answered and
// is delivered again as "CHANGED", and the follow-ups follow the new answer without undoing the old one's.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; } // connects as the dashboard (cb-web)
function session() { const s = postgres(TEST_URL, { onnotice: () => {} }); clients.push(s); return s; }

const ask = async (sql: any, o: { body: string; options?: string[]; parent?: string; if?: string; task?: string; blocking?: boolean; to?: string }) =>
  Number((await sql`select cb.ask(project => 'demo', body => ${o.body}, options => ${o.options ? sql.json(o.options) : null},
    parent => ${o.parent ?? null}, if_answer => ${o.if ?? null}, task_id => ${o.task ?? null}, blocking => ${o.blocking ?? false},
    to_user => ${o.to ?? null}, reply_to => ${sql.json({ machine: 'mac', pane: 'w1:p3' })}, actor => 'W1') as q`)[0].q);
const q = async (sql: any, id: number) => (await sql`select * from cb.questions where id = ${id}`)[0];
const answer = (sql: any, id: number, a: string) => sql`select cb.answer(${String(id)}, ${a})`;
const deliver = (sql: any, id: number) => sql`select cb.answer_delivered(${String(id)}, 'W1')`;
const inbox = async (sql: any) => (await sql`select cb.inbox('mac', 'w1:p3', 0) as i`)[0].i;

async function delivered(sql: any) {
  await sql`select cb.task_add(project => 'demo', title => 'seed')`;
  await sql`select cb.iam('mac', 'w1:p3', 'W1', 'demo')`;
  const id = await ask(sql, { body: 'Ship today?', options: ['Yes', 'No'] });
  await answer(sql, id, 'Yes');
  await deliver(sql, id);
  return id;
}

test('a delivered answer changed from the dashboard: back to answered, the old one kept, delivered again as a change', async () => {
  const sql = await db();
  const id = await delivered(sql);
  await answer(sql, id, 'No');
  const row = await q(sql, id);
  assert.equal(row.status, 'answered');
  assert.equal(row.answer, 'No');
  assert.equal(row.delivered_to, null, 'not delivered any more');
  assert.equal(row.delivered_at, null);
  assert.equal(row.answer_history.length, 1);
  assert.deepEqual([row.answer_history[0].answer, row.answer_history[0].answered_by, row.answer_history[0].delivered_to, row.answer_history[0].changed_by],
    ['Yes', 'ahmed', 'W1', 'ahmed']);
  const i = await inbox(sql);
  assert.deepEqual(i.answers.map((a: any) => [a.id, a.answer, a.was]), [[id, 'No', 'Yes']]);
  const [ev] = await sql`select data from cb.events where kind = 'answered' order by id desc limit 1`;
  assert.deepEqual([ev.data.changed, ev.data.was], [true, 'Yes'], 'the orchestrator copy can say it changed');
  assert.deepEqual((await sql`select q.was from cb.brief('demo') b, jsonb_to_recordset(b -> 'answered_pending') q(was text)`).map((r: any) => r.was), ['Yes']);
  await deliver(sql, id);
  assert.equal((await q(sql, id)).status, 'delivered');
  // a second change keeps both earlier answers, oldest first
  await answer(sql, id, 'Yes, Monday');
  assert.deepEqual((await q(sql, id)).answer_history.map((h: any) => h.answer), ['Yes', 'No']);
});

test('changing before delivery works as it did: no history, no "was"', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'seed')`;
  const id = await ask(sql, { body: 'Ship today?', options: ['Yes', 'No'] });
  await answer(sql, id, 'Yes');
  await answer(sql, id, 'No');
  const row = await q(sql, id);
  assert.deepEqual([row.status, row.answer, row.answer_history], ['answered', 'No', null]);
  assert.equal((await inbox(sql)).answers[0]?.was ?? null, null);
});

test('only the dashboard changes a delivered answer; the same answer again changes nothing; withdrawn is refused', async () => {
  const sql = await db();
  const id = await delivered(sql);
  await assert.rejects(session()`select cb.answer(${String(id)}, 'No', 'W1')`, /Q\d+ is already delivered/);
  await answer(sql, id, ' Yes ');
  assert.equal((await q(sql, id)).status, 'delivered', 'nothing to correct');
  const w = await ask(sql, { body: 'Other?' });
  await sql`select cb.withdraw(${String(w)}, 'W1')`;
  await assert.rejects(answer(sql, w, 'x'), /Q\d+ is already withdrawn/);
});

test('a pending correction cannot be withdrawn: the session takes it instead', async () => {
  const sql = await db();
  const id = await delivered(sql);
  await answer(sql, id, 'No');
  await assert.rejects(sql`select cb.withdraw(${String(id)}, 'W1')`, /changed answer on its way/);
});

test('follow-ups: the new answer opens its branch (skipped at delivery); the old branch stays; one withdrawn by hand stays withdrawn', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'seed')`;
  const p = await ask(sql, { body: 'Ship today?', options: ['Yes', 'No'] });
  const fy = await ask(sql, { body: 'Which env first?', parent: 'Q' + p, if: 'Yes' });
  const fn = await ask(sql, { body: 'When then?', parent: 'Q' + p, if: 'No' });
  const fn2 = await ask(sql, { body: 'Tell the client?', parent: 'Q' + p, if: 'No' });
  const deep = await ask(sql, { body: 'Which day?', parent: 'Q' + fn });  // waits on the No branch
  await sql`select cb.withdraw(${String(fn2)}, 'W1')`;  // the session withdrew this one itself
  await answer(sql, p, 'Yes');
  await deliver(sql, p);
  assert.deepEqual([(await q(sql, fy)).status, (await q(sql, fn)).status, (await q(sql, deep)).status], ['open', 'withdrawn', 'withdrawn']);
  await answer(sql, fy, 'SIT');  // the old branch is answered already: the change still goes through
  await answer(sql, p, 'No');
  assert.deepEqual([(await q(sql, fy)).status, (await q(sql, fn)).status, (await q(sql, fn2)).status, (await q(sql, deep)).status],
    ['answered', 'open', 'withdrawn', 'dormant'], 'No opens; Yes stays; the hand-withdrawn stays; the deeper one waits again');
  // edit again before delivery, then deliver: the old branch is still open, "was" is what the session was told
  const fy2 = await ask(sql, { body: 'Notify QA?', parent: 'Q' + fn });
  await answer(sql, p, 'No, next week');
  assert.equal((await q(sql, fn)).status, 'open');
  assert.equal((await inbox(sql)).answers.find((a: any) => a.id === p)?.was, 'Yes');
  await deliver(sql, p);
  assert.deepEqual([(await q(sql, p)).status, (await q(sql, fy)).status, (await q(sql, fn)).status, (await q(sql, fy2)).status],
    ['delivered', 'answered', 'open', 'dormant']);
});

test('a redelivered change leaves the task alone: it was released at the first delivery', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'build it', assignee => 'W1', status => 'in_progress', actor => 'W1')`;
  await sql`select cb.iam('mac', 'w1:p3', 'W1', 'demo')`;
  const id = await ask(sql, { body: 'Which DB?', options: ['PG', 'Mongo'], task: '1', blocking: true });
  assert.equal((await sql`select status from cb.tasks where id = 1`)[0].status, 'blocked');
  await answer(sql, id, 'PG');
  await deliver(sql, id);
  assert.equal((await sql`select status from cb.tasks where id = 1`)[0].status, 'in_progress');
  await sql`select cb.task_move('1', 'blocked', 'waiting on infra', 'W1')`;  // blocked again, for another reason
  await answer(sql, id, 'Mongo');
  assert.equal((await sql`select status from cb.tasks where id = 1`)[0].status, 'blocked', 'the change does not take the task');
  await deliver(sql, id);
  assert.equal((await sql`select status from cb.tasks where id = 1`)[0].status, 'blocked', 'nor does its delivery release it');
});

test('cb pending says CHANGED with the old answer', async () => {
  const sql = await db();
  const id = await delivered(sql);
  await answer(sql, id, 'No');
  const r = spawnSync('node', ['cli/cb.ts', 'pending', 'demo'], { encoding: 'utf8',
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'W1', HERDR_PANE_ID: '' } });
  assert.match(r.stdout, new RegExp(`Q${id} → W1[\\s\\S]*answer: No\\n  CHANGED: was "Yes"\\. Undo or redo what you did based on the old answer\\.`), r.stdout + r.stderr);
});

test('a correction holds no task: a follow-up giving its task back does not hand it to the corrected question', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'build it', assignee => 'W1', status => 'in_progress', actor => 'W1')`;
  await sql`select cb.iam('mac', 'w1:p3', 'W1', 'demo')`;
  const q1 = await ask(sql, { body: 'Which DB?', options: ['PG', 'Mongo'], task: '1', blocking: true });
  const p = await ask(sql, { body: 'Ship today?', options: ['Yes', 'No'] });
  const f = await ask(sql, { body: 'Which env?', parent: 'Q' + p, if: 'Yes', task: '1', blocking: true });
  await answer(sql, p, 'Yes');  // f opens and takes the task, remembering it was blocked on q1
  assert.equal(Number((await sql`select blocked_on from cb.tasks where id = 1`)[0].blocked_on), f);
  await answer(sql, q1, 'PG');
  await deliver(sql, q1);
  await answer(sql, q1, 'Mongo');  // q1 is answered again: a correction
  await answer(sql, p, 'No');      // f waits again and gives the task back
  const [t] = await sql`select status, blocked_on from cb.tasks where id = 1`;
  assert.deepEqual([t.status, t.blocked_on], ['in_progress', null], 'not blocked on the corrected q1');
});
