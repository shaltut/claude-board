// Epics (one level of ordered steps) and task-on-task blockers (#341).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; }
/** A session's connection: anything but the dashboard's application_name. */
function session() { const s = postgres(TEST_URL, { onnotice: () => {} }); clients.push(s); return s; }

function cb(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('node', ['cli/cb.ts', ...args], {
    encoding: 'utf8', env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'W1@test', HERDR_PANE_ID: '', ...env },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const add = async (sql: any, title: string, o: Record<string, string> = {}) =>
  Number((await sql`select cb.task_add(project => ${o.project ?? 'demo'}, title => ${title}, status => ${o.status ?? 'next'},
    assignee => ${o.assignee ?? null}, actor => ${o.actor ?? 'W1@pc'}) as id`)[0].id);
const task = async (sql: any, id: number) => (await sql`select * from cb.tasks where id = ${id}`)[0];
const events = (sql: any, id: number) => sql`select * from cb.events where task_id = ${id} order by id`;

test('epics: only the dashboard creates, renames, closes and deletes; a session adds its tasks to one', async () => {
  const web = await db();
  const s = session();
  await web`select cb.ensure_project('demo')`;
  await assert.rejects(s`select cb.epic_create('demo', 'Payer gateway', 'retry and contract tests', 'W1@pc')`, /only Ahmed/);
  const [{ id }] = await web`select cb.epic_create('demo', 'Payer gateway', 'retry and contract tests', 'ahmed') as id`;
  const e = Number(id);
  await assert.rejects(s`select cb.epic_update(${String(e)}, 'x', null, 'W1@pc')`, /only Ahmed/);
  await assert.rejects(s`select cb.epic_close(${String(e)}, true, 'W1@pc')`, /only Ahmed/);
  await assert.rejects(s`select cb.epic_delete(${String(e)}, 'W1@pc')`, /only Ahmed/);

  // a session adds tasks: at add time (E3 or 3) and by edit; none takes it out
  const [{ id: t1 }] = await s`select cb.task_add(project => 'demo', title => 'retry', epic => ${'E' + e}, actor => 'W1@pc') as id`;
  const t2 = await add(s, 'contract tests');
  await s`select cb.task_update(${String(t2)}, ${s.json({ epic: String(e) })}, 'W1@pc')`;
  assert.equal(Number((await task(s, Number(t1))).epic_id), e);
  const a = await task(s, Number(t1)), b = await task(s, t2);
  assert.equal(Number(b.epic_id), e);
  assert.ok(b.epic_rank > a.epic_rank, 'a step joins at the end');
  const [ev] = (await events(s, t2)).filter((x: any) => x.kind === 'updated');
  assert.match(ev.summary, new RegExp(`added to epic E${e}`));
  await s`select cb.task_update(${String(t2)}, ${s.json({ epic: 'none' })}, 'W1@pc')`;
  assert.equal((await task(s, t2)).epic_id, null);

  // reorder (Ahmed drags) is silent: no event, no updated_at bump
  const before = await task(web, Number(t1));
  await web`select cb.task_update(${String(t1)}, ${web.json({ epic_rank: 99999 })}, 'ahmed')`;
  const moved = await task(web, Number(t1));
  assert.equal(moved.epic_rank, 99999);
  assert.equal(+moved.updated_at, +before.updated_at);

  await web`select cb.epic_update(${String(e)}, 'Payer gateway v2', null, 'ahmed')`;
  await web`select cb.epic_close(${String(e)}, true, 'ahmed')`;
  await web`select cb.epic_delete(${String(e)}, 'ahmed')`;
  assert.equal((await task(web, Number(t1))).epic_id, null, 'deleting an epic keeps its tasks');
  const audit = await web`select data ->> 'action' as a from cb.events where kind = 'epic' order by id`;
  assert.deepEqual(audit.map((r: any) => r.a), ['create', 'rename', 'close', 'delete']);
});

test('epics: progress counts cancelled as finished; done when all are finished or Ahmed closes it', async () => {
  const web = await db();
  await web`select cb.ensure_project('demo')`;
  const e = Number((await web`select cb.epic_create('demo', 'E', '', 'ahmed') as id`)[0].id);
  const list = async () => (await web`select cb.epics_list('demo') as l`)[0].l[0];
  assert.equal((await list()).status, 'open', 'an empty epic is open');
  const [a, b, c] = [await add(web, 'a'), await add(web, 'b'), await add(web, 'c')];
  for (const t of [a, b, c]) await web`select cb.task_update(${String(t)}, ${web.json({ epic: 'E' + e })}, 'ahmed')`;
  await web`select cb.task_done(${String(a)}, 'ok')`;
  await web`select cb.task_move(${String(b)}, 'cancelled')`;
  let l = await list();
  assert.deepEqual([l.total, l.finished, l.done, l.cancelled, l.status], [3, 2, 1, 1, 'open']);
  await web`select cb.task_done(${String(c)}, 'ok')`;
  assert.equal((await list()).status, 'done');
  await web`select cb.task_move(${String(c)}, 'in_progress')`;
  assert.equal((await list()).status, 'open');
  await web`select cb.epic_close(${String(e)}, true, 'ahmed')`;
  assert.equal((await list()).status, 'done', 'Ahmed closed it');
});

test('epics and blockers stay inside one project', async () => {
  const web = await db();
  await web`select cb.ensure_project('demo'), cb.ensure_project('other')`;
  const e = Number((await web`select cb.epic_create('demo', 'E', '', 'ahmed') as id`)[0].id);
  const x = await add(web, 'elsewhere', { project: 'other' });
  await assert.rejects(web`select cb.task_update(${String(x)}, ${web.json({ epic: 'E' + e })}, 'W1@pc')`, /E\d+ is in demo, #\d+ in other: an epic holds one project's tasks/);
  await assert.rejects(web`select cb.task_add(project => 'other', title => 'y', epic => ${'E' + e})`, /an epic holds one project's tasks/);
  await assert.rejects(web`select cb.task_update(${String(x)}, ${web.json({ epic: 'E999' })}, 'W1@pc')`, /no epic E999/);
  const d = await add(web, 'here');
  await assert.rejects(web`select cb.task_block(${String(d)}, ${String(x)}, 'W1@pc')`, /#\d+ is in other, #\d+ in demo: blockers stay inside one project/);
  // moving a task with an epic or blockers to another project is refused, not silently split
  await web`select cb.task_update(${String(d)}, ${web.json({ epic: 'E' + e })}, 'W1@pc')`;
  await assert.rejects(web`select cb.task_update(${String(d)}, ${web.json({ project: 'other' })}, 'W1@pc')`, /in epic E\d+/);
  // an alias merge carries the project's epics along
  await web`select cb.ensure_project('old')`;
  const eo = Number((await web`select cb.epic_create('old', 'Old epic', '', 'ahmed') as id`)[0].id);
  const o = await add(web, 'old step', { project: 'old' });
  await web`select cb.task_update(${String(o)}, ${web.json({ epic: 'E' + eo })}, 'ahmed')`;
  await web`select cb.project_alias('old', 'demo')`;
  const [m] = await web`select e.project, t.project as tp from cb.epics e join cb.tasks t on t.epic_id = e.id where e.id = ${eo}`;
  assert.deepEqual([m.project, m.tp], ['demo', 'demo']);
});

test('blockers: self-links and cycles, long ones too, are refused', async () => {
  const sql = await db();
  const [a, b, c, d] = [await add(sql, 'a'), await add(sql, 'b'), await add(sql, 'c'), await add(sql, 'd')];
  await assert.rejects(sql`select cb.task_block(${String(a)}, ${String(a)}, 'W1@pc')`, /cannot block itself/);
  await sql`select cb.task_block(${String(b)}, ${String(a)}, 'W1@pc')`; // b waits on a
  await sql`select cb.task_block(${String(c)}, ${String(b)}, 'W1@pc')`; // c waits on b
  await sql`select cb.task_block(${String(d)}, ${String(c)}, 'W1@pc')`; // d waits on c
  await assert.rejects(sql`select cb.task_block(${String(a)}, ${String(d)}, 'W1@pc')`, /cycle/);
  await assert.rejects(sql`select cb.task_block(${String(a)}, ${String(b)}, 'W1@pc')`, /cycle/);
  // and directly in the table, not only through the function
  await assert.rejects(sql`insert into cb.task_blockers (task, blocker) values (${a}, ${c})`, /cycle/);
  await assert.rejects(sql`select cb.task_block(${String(a)}, ${'999'}, 'W1@pc')`, /task #999 not found/);
});

test('blockers: adding an open one moves the task to Blocked with one event; a finished task is refused', async () => {
  const sql = await db();
  const a = await add(sql, 'a'), b = await add(sql, 'b', { status: 'in_progress', assignee: 'W2@pc' });
  const n0 = (await sql`select count(*)::int n from cb.events`)[0].n;
  await sql`select cb.task_block(${String(b)}, ${String(a)}, 'W1@pc')`;
  assert.equal((await task(sql, b)).status, 'blocked');
  const evs = await sql`select * from cb.events where id > 0 order by id offset ${n0}`;
  assert.equal(evs.length, 1, 'block leaves one event');
  assert.equal(evs[0].kind, 'moved');
  assert.equal(evs[0].summary, `blocked by #${a}`);
  // W2 is told (the relay's events channel)
  await sql`select cb.iam('pc', 'p2', 'W2@pc', 'demo')`;
  const [{ i }] = await sql`select cb.inbox('pc', 'p2', ${evs[0].id - 1}) as i`;
  assert.deepEqual(i.events.map((e: any) => e.summary), [`blocked by #${a}`]);
  // a blocker that is already done records the link without moving anything
  const c = await add(sql, 'c'); await sql`select cb.task_done(${String(c)}, 'ok')`;
  const d = await add(sql, 'd');
  await sql`select cb.task_block(${String(d)}, ${String(c)}, 'W1@pc')`;
  assert.equal((await task(sql, d)).status, 'next');
  await assert.rejects(sql`select cb.task_block(${String(c)}, ${String(d)}, 'W1@pc')`, /#\d+ is done: a finished task waits on nothing/);
});

test('blockers: done → Next and the assignee is told; with two blockers only after both', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo'), cb.iam('pc', 'p2', 'W2@pc', 'demo')`;
  const a = await add(sql, 'a'), b = await add(sql, 'b');
  const t = await add(sql, 'waits', { status: 'in_progress', assignee: 'W2@pc' });
  await sql`select cb.task_block(${String(t)}, ${String(a)}, 'W1@pc')`;
  await sql`select cb.task_block(${String(t)}, ${String(b)}, 'W1@pc')`;
  const [{ start }] = await sql`select max(id) as start from cb.events`;
  await sql`select cb.task_done(${String(a)}, 'merged', ${sql.json({ pr: '#9' })}, 'W1@pc')`;
  assert.equal((await task(sql, t)).status, 'blocked', 'one blocker still open');
  await sql`select cb.task_done(${String(b)}, 'merged too', ${sql.json({ pr: '#10' })}, 'W1@pc')`;
  const after = await task(sql, t);
  assert.equal(after.status, 'next');
  assert.equal(after.assignee, 'W2@pc', 'still theirs');
  const [mv] = (await events(sql, t)).filter((e: any) => e.kind === 'moved' && e.id > start);
  assert.equal(mv.summary, `unblocked: #${b} is done`);
  assert.equal(mv.data.links, undefined, "the blocker's links stay on the blocker");
  const [done] = (await events(sql, b)).filter((e: any) => e.kind === 'done');
  assert.equal(done.summary, 'merged too', "the blocker's own event keeps its summary");
  const [{ i }] = await sql`select cb.inbox('pc', 'p2', ${start}) as i`;
  assert.ok(i.events.some((e: any) => e.task_id === t && e.summary === `unblocked: #${b} is done`), JSON.stringify(i.events));
});

test('blockers: a cancelled blocker unblocks; with no assignee the orchestrator gets a message', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo'), cb.iam('pc', 'o1', 'orch@pc', 'demo')`;
  const a = await add(sql, 'a'), t = await add(sql, 'waits', { status: 'backlog' });
  await sql`select cb.task_block(${String(t)}, ${String(a)}, 'W1@pc')`;
  const [{ start }] = await sql`select max(id) as start from cb.events`;
  await sql`select cb.task_move(${String(a)}, 'cancelled', null, 'W1@pc')`;
  assert.equal((await task(sql, t)).status, 'next');
  const [mv] = (await events(sql, t)).filter((e: any) => e.kind === 'moved' && e.id > start);
  assert.equal(mv.summary, `unblocked: #${a} was cancelled`);
  const [msg] = await sql`select * from cb.events where kind = 'message' and id > ${start}`;
  assert.equal(msg.data.to, 'orch@pc');
  assert.match(msg.summary, new RegExp(`unblocked: #${t} .*#${a} was cancelled`));
  assert.match(msg.summary, new RegExp(`cb edit ${t} --assignee <worker>`), 'hands out this task, not the top of the queue');
  const [{ i }] = await sql`select cb.inbox('pc', 'o1', ${start}) as i`;
  assert.equal(i.messages.length, 1);
});

test('blockers: a task also blocked on a question stays blocked until both clear, whichever clears first', async () => {
  const sql = await db();
  // blocker clears first: still held by the question; the answer then releases it
  const a = await add(sql, 'a'), t = await add(sql, 't', { status: 'in_progress', assignee: 'W2@pc' });
  await sql`select cb.task_block(${String(t)}, ${String(a)}, 'W1@pc')`;
  const q = Number((await sql`select cb.ask(project => 'demo', body => 'which?', blocking => true, task_id => ${String(t)}, actor => 'W2@pc') as q`)[0].q);
  assert.equal(Number((await task(sql, t)).blocked_on), q);
  await sql`select cb.task_done(${String(a)}, 'ok')`;
  let x = await task(sql, t);
  assert.deepEqual([x.status, Number(x.blocked_on)], ['blocked', q]);
  await sql`select cb.answer(${String(q)}, 'this one')`;
  await sql`select cb.answer_delivered(${String(q)}, 'W2@pc')`;
  x = await task(sql, t);
  assert.deepEqual([x.status, x.blocked_on], ['in_progress', null], 'a question release keeps its own rule');

  // question clears first: still held by the open blocker; the blocker then releases it
  const b = await add(sql, 'b'), u = await add(sql, 'u', { status: 'in_progress', assignee: 'W2@pc' });
  const q2 = Number((await sql`select cb.ask(project => 'demo', body => 'and?', blocking => true, task_id => ${String(u)}, actor => 'W2@pc') as q`)[0].q);
  await sql`select cb.task_block(${String(u)}, ${String(b)}, 'W1@pc')`;
  await sql`select cb.answer(${String(q2)}, 'go')`;
  await sql`select cb.answer_delivered(${String(q2)}, 'W2@pc')`;
  x = await task(sql, u);
  assert.deepEqual([x.status, x.blocked_on], ['blocked', null], 'answered, but #b is still open');
  await sql`select cb.task_done(${String(b)}, 'ok')`;
  assert.equal((await task(sql, u)).status, 'next');

  // a withdrawn question behaves the same
  const c = await add(sql, 'c'), w = await add(sql, 'w', { status: 'in_progress', assignee: 'W2@pc' });
  await sql`select cb.task_block(${String(w)}, ${String(c)}, 'W1@pc')`;
  const q3 = Number((await sql`select cb.ask(project => 'demo', body => 'or?', blocking => true, task_id => ${String(w)}, actor => 'W2@pc') as q`)[0].q);
  await sql`select cb.withdraw(${String(q3)}, 'W2@pc')`;
  x = await task(sql, w);
  assert.deepEqual([x.status, x.blocked_on], ['blocked', null]);
});

test('unblock: removing the last open blocker moves the task to Next; one event', async () => {
  const sql = await db();
  const a = await add(sql, 'a'), b = await add(sql, 'b'), t = await add(sql, 't');
  await sql`select cb.task_block(${String(t)}, ${String(a)}, 'W1@pc')`;
  await sql`select cb.task_block(${String(t)}, ${String(b)}, 'W1@pc')`;
  const n = async () => (await sql`select count(*)::int n from cb.events where task_id = ${t}`)[0].n;
  let k = await n();
  await sql`select cb.task_unblock(${String(t)}, ${String(a)}, 'W1@pc')`;
  assert.equal((await task(sql, t)).status, 'blocked');
  assert.equal(await n(), k + 1);
  k = await n();
  await sql`select cb.task_unblock(${String(t)}, ${String(b)}, 'W1@pc')`;
  assert.equal((await task(sql, t)).status, 'next');
  assert.equal(await n(), k + 1);
  await assert.rejects(sql`select cb.task_unblock(${String(t)}, ${String(b)}, 'W1@pc')`, /not blocked by/);
});

test('cli: cb block / unblock, --epic on add and edit, cb epics; done says what it unblocked', async () => {
  const web = await db();
  await web`select cb.ensure_project('demo')`;
  const e = Number((await web`select cb.epic_create('demo', 'Payer gateway', '', 'ahmed') as id`)[0].id);
  assert.equal(cb(['add', 'demo', 'first', '-s', 'next', '--epic', `E${e}`]).out, '#1');
  assert.equal(cb(['add', 'demo', 'second', '-s', 'next']).out, '#2');
  let r = cb(['edit', '2', '--epic', `E${e}`]);
  assert.equal(r.code, 0, r.err);
  r = cb(['block', '2', '--by', '1']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /#2 waits on #1 \(now blocked\)/);
  r = cb(['block', '2']);
  assert.equal(r.code, 1);
  assert.match(r.err, /usage: cb block <task> --by <task>/);
  r = cb(['epics', 'demo']);
  assert.match(r.out, new RegExp(`E${e} \\[open\\] Payer gateway · demo · 0 of 2 done`));
  r = cb(['done', '1', 'shipped']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /#1 done\n#2 unblocked: now next/);
  r = cb(['unblock', '2', '--by', '1']);
  assert.equal(r.code, 0, r.err);
  r = cb(['edit', '2', '--epic', 'none']);
  assert.equal(r.code, 0, r.err);
  assert.equal((await task(web, 2)).epic_id, null);
});

test('tick: a task waiting on an open blocker is not stuck; with nothing holding it, it is', async () => {
  const sql = await db();
  const a = await add(sql, 'a', { status: 'in_progress', assignee: 'W1@pc' }), t = await add(sql, 'waits');
  await sql`select cb.task_block(${String(t)}, ${String(a)}, 'W1@pc')`;
  await sql`update cb.events set at = now() - interval '2 hours'`;
  await sql`update cb.tasks set updated_at = now() - interval '2 hours'`;
  const blocked = async () => (await sql`select cb.tick('demo', 'orch@pc') as t`)[0].t.blocked.map((x: any) => x.id);
  assert.deepEqual(await blocked(), [], 'it waits on #a by design');
  await sql`delete from cb.task_blockers`; // a blocker gone without the release (e.g. its row removed by hand)
  assert.deepEqual(await blocked(), [t]);
});

/** Both transactions open before either commits: `first` runs, `second` starts (it may wait on a lock), then
 *  `first` commits and `second` finishes. Read committed, as every cb call runs. */
async function interleave(first: (tx: any) => Promise<unknown>, second: (tx: any) => Promise<unknown>) {
  const c1 = await session().reserve(), c2 = await session().reserve();
  try {
    await c1`begin`; await first(c1);
    await c2`begin`; const p = second(c2); p.catch(() => {});
    await new Promise((r) => setTimeout(r, 300)); // let the second reach its statement (and its lock, once there is one)
    await c1`commit`; await p; await c2`commit`;
  } finally { c1.release(); c2.release(); }
}

test('races: two blockers finishing at once still release the task (lost wake-up A)', async () => {
  const sql = await db();
  const a = await add(sql, 'a'), b = await add(sql, 'b'), t = await add(sql, 't');
  await sql`select cb.task_block(${String(t)}, ${String(a)}, 'W1@pc')`;
  await sql`select cb.task_block(${String(t)}, ${String(b)}, 'W1@pc')`;
  await interleave((x) => x`select cb.task_done(${String(a)}, 'ok', '{}', 'W1@pc')`,
                   (x) => x`select cb.task_done(${String(b)}, 'ok', '{}', 'W2@pc')`);
  assert.equal((await task(sql, t)).status, 'next');
});

test('races: the answer delivered while the last blocker finishes still releases the task (B)', async () => {
  const sql = await db();
  const a = await add(sql, 'a'), t = await add(sql, 't', { status: 'in_progress', assignee: 'W2@pc' });
  await sql`select cb.task_block(${String(t)}, ${String(a)}, 'W1@pc')`;
  const q = Number((await sql`select cb.ask(project => 'demo', body => 'which?', blocking => true, task_id => ${String(t)}, actor => 'W2@pc') as q`)[0].q);
  await sql`select cb.answer(${String(q)}, 'this one')`;
  await interleave((x) => x`select cb.answer_delivered(${String(q)}, 'W2@pc', 'orch@pc')`,
                   (x) => x`select cb.task_done(${String(a)}, 'ok', '{}', 'W1@pc')`);
  const x = await task(sql, t);
  assert.deepEqual([x.status, x.blocked_on], ['next', null]);
});

test('races: blocking on a task that is being finished never leaves the task held by a done blocker (D)', async () => {
  const sql = await db();
  const a = await add(sql, 'a'), t = await add(sql, 't');
  await interleave((x) => x`select cb.task_done(${String(a)}, 'ok', '{}', 'W1@pc')`,
                   (x) => x`select cb.task_block(${String(t)}, ${String(a)}, 'W2@pc')`);
  assert.equal((await task(sql, t)).status, 'next');
});

test('races: an edit that does not name the epic leaves a concurrent epic change alone', async () => {
  const web = await db();
  const e = Number((await web`select cb.ensure_project('demo'), cb.epic_create('demo', 'Gateway', '', 'ahmed') as id`)[0].id);
  const t = await add(web, 't');
  await interleave((x) => x`select cb.task_update(${String(t)}, ${x.json({ epic: 'E' + e })}, 'W1@pc')`,
                   (x) => x`select cb.task_update(${String(t)}, ${x.json({ title: 'renamed' })}, 'W2@pc')`);
  const x = await task(web, t);
  assert.deepEqual([x.title, Number(x.epic_id)], ['renamed', e]);
});
