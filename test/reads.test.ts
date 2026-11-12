// Multi-user sessions, phase 3: what the CLI reads comes from cb.* functions, each able to hide other projects.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb } from './helpers.ts'; // sets CB_DATABASE_URL before the server's db client loads

const clients: any[] = [];
let serverSql: any;
after(() => Promise.all([...clients.map((c) => c.end()), serverSql?.end()]));
async function db() { const s = await freshDb(); clients.push(s); return s; }

const A = ['a'];
/** cb.<fn>(...args) as one jsonb value. Arrays and objects go as jsonb, as server/rpc.ts sends them. */
const call = async (sql: any, fn: string, ...args: unknown[]) =>
  (await sql.unsafe(`select cb.${fn}(${args.map((a, i) => `$${i + 1}${a !== null && typeof a === 'object' ? '::jsonb' : ''}`).join(', ')}) as r`, args as any[]))[0].r;
const asSession = (sql: any, run: (tx: any) => Promise<any>) =>
  sql.begin(async (tx: any) => { await tx`set local application_name = 'psql'`; return run(tx); });

/** Two projects with the same things in each: a is the one in scope, b the one that must stay invisible. */
async function seed(sql: any) {
  const ids: any = {};
  for (const p of ['a', 'b']) {
    await sql`select cb.ensure_project(${p})`;
    for (const w of ['W1@', 'W2@']) await sql`select cb.iam(${p + '-box'}, ${w === 'W1@' ? 'p1' : 'p2'}, ${w + p}, ${p})`;
    const add = async (title: string, status: string, priority: string) =>
      Number((await sql`select cb.task_add(project => ${p}, title => ${title}, body => ${'body ' + p}, status => ${status}, priority => ${priority}, actor => ${'W1@' + p}) as id`)[0].id);
    ids[p] = { next: await add('next in ' + p, 'next', 'P1'), doing: await add('doing in ' + p, 'in_progress', 'P2') };
    await sql`update cb.tasks set assignee = ${'W1@' + p} where id = ${ids[p].doing}`;
    await sql`select cb.log(project => ${p}, summary => ${'note in ' + p}, task_id => ${String(ids[p].doing)}, actor => ${'W1@' + p})`;
    ids[p].q = Number((await sql`select cb.ask(project => ${p}, body => ${'question in ' + p}, options => '["Yes","No"]'::jsonb, actor => ${'W1@' + p}) as id`)[0].id);
    ids[p].h = Number((await sql`select cb.huddle_open(topic => ${'topic ' + p}, members => ${sql.json(['W2@' + p])}, actor => ${'W1@' + p}, project => ${p}) as id`)[0].id);
    await sql`select cb.huddle_say(${String(ids[p].h)}, ${'line in ' + p}, ${'W1@' + p})`;
  }
  return ids;
}

test('_in_scope: null is the whole board; anything that is not an array holding the project hides it', async () => {
  const sql = await db();
  const inScope = async (p: string | null, s: unknown) => (await sql.unsafe('select cb._in_scope($1, $2::jsonb) as r', [p, s] as any[]))[0].r;
  assert.equal(await inScope('a', null), true);
  assert.equal(await inScope(null, null), true);
  assert.equal(await inScope('a', ['a', 'c']), true);
  for (const s of [[], ['b'], 'a', { a: 1 }, [['a']], ['A']]) assert.equal(await inScope('a', s), false, JSON.stringify(s));
  assert.equal((await sql`select cb._in_scope('a', 'null'::jsonb) as r`)[0].r, false, 'JSON null is not "no scope"');
  assert.equal(await inScope(null, ['a']), false, 'nothing without a project is in a scope');
});

test('task_peek and task_show: another project\'s id answers like one that does not exist', async () => {
  const sql = await db(); const ids = await seed(sql);
  const peek = await call(sql, 'task_peek', ids.a.doing, null);
  assert.deepEqual(peek, { id: ids.a.doing, project: 'a', status: 'in_progress', triagers: ['W1@a', 'W2@a'] });
  assert.deepEqual((await call(sql, 'task_peek', ids.b.doing, null)).project, 'b');
  assert.equal(await call(sql, 'task_peek', ids.b.doing, A), null);
  assert.equal(await call(sql, 'task_peek', 9999, A), null);
  assert.equal((await call(sql, 'task_peek', ids.a.doing, A)).project, 'a');

  const t = await call(sql, 'task_show', ids.a.doing, null);
  assert.equal(t.title, 'doing in a'); assert.equal(t.body, 'body a'); assert.equal(t.assignee, 'W1@a');
  assert.deepEqual(t.notes.map((n: any) => [n.actor, n.summary]), [['W1@a', 'note in a']]);
  assert.ok(t.notes[0].at);
  assert.deepEqual(t.goals, []);
  assert.equal(await call(sql, 'task_show', ids.b.doing, A), null);
  assert.equal(await call(sql, 'task_show', 9999, null), null);
  assert.equal((await call(sql, 'task_show', ids.a.doing, A)).id, ids.a.doing);
});

test('task_show: the goals a card is in, active first, never a finished one', async () => {
  const sql = await db(); const ids = await seed(sql);
  const g = Number((await sql`insert into cb.goals (title, project, created_by) values ('Ship a', 'a', 'ahmed') returning id`)[0].id);
  await sql`insert into cb.goal_tasks (goal_id, task_id, state) values (${g}, ${ids.a.doing}, 'in')`;
  assert.deepEqual((await call(sql, 'task_show', ids.a.doing, null)).goals, [{ id: g, title: 'Ship a', status: 'active' }]);
  await sql`update cb.goals set status = 'done' where id = ${g}`;
  assert.deepEqual((await call(sql, 'task_show', ids.a.doing, null)).goals, []);
});

test('projects_summary: counts per project, and only the projects in scope', async () => {
  const sql = await db(); await seed(sql);
  assert.deepEqual(await call(sql, 'projects_summary', null),
    [{ slug: 'a', next: 1, doing: 1, live: 2 }, { slug: 'b', next: 1, doing: 1, live: 2 }]);
  assert.deepEqual(await call(sql, 'projects_summary', A), [{ slug: 'a', next: 1, doing: 1, live: 2 }]);
  assert.deepEqual(await call(sql, 'projects_summary', []), []);
});

test('queue_head: the order cb next takes them in, never a task queued for someone else, never out of scope', async () => {
  const sql = await db(); const ids = await seed(sql);
  const p0 = Number((await sql`select cb.task_add(project => 'a', title => 'urgent', status => 'next', priority => 'P0', actor => 'W1@a') as id`)[0].id);
  const theirs = Number((await sql`select cb.task_add(project => 'a', title => 'for W2', status => 'next', priority => 'P0', actor => 'W1@a') as id`)[0].id);
  await sql`update cb.tasks set assignee = 'W2@a' where id = ${theirs}`;
  const head = await call(sql, 'queue_head', 'a', 'W1@a', 3, null);
  assert.deepEqual(head.map((t: any) => t.id), [p0, ids.a.next]);
  assert.deepEqual(Object.keys(head[0]).sort(), ['assignee', 'id', 'labels', 'priority', 'project', 'title']);
  assert.equal(Number((await sql`select id from cb.task_claim('a', 'W1@a')`)[0].id), p0, 'the head is what cb next takes');
  assert.deepEqual((await call(sql, 'queue_head', 'a', 'W1@a', 1, null)).length, 1);
  assert.deepEqual(await call(sql, 'queue_head', 'b', 'W1@a', 3, A), []);
  assert.equal((await call(sql, 'queue_head', 'b', 'W1@a', 3, null)).length, 1);
});

test('questions_asked: mine by status; sent-back ones only when asked for; scoped', async () => {
  const sql = await db(); const ids = await seed(sql);
  const other = Number((await sql`select cb.ask(project => 'b', body => 'W1@a asks in b', actor => 'W1@a') as id`)[0].id);
  assert.deepEqual(await call(sql, 'questions_asked', 'W1@a', false, null),
    [{ id: ids.a.q, status: 'open', body: 'question in a' }, { id: other, status: 'open', body: 'W1@a asks in b' }]);
  assert.deepEqual((await call(sql, 'questions_asked', 'W1@a', false, A)).map((q: any) => q.id), [ids.a.q]);
  await sql`update cb.questions set status = 'sent_back' where id = ${ids.a.q}`;
  assert.deepEqual((await call(sql, 'questions_asked', 'W1@a', false, A)), []);
  assert.deepEqual((await call(sql, 'questions_asked', 'W1@a', true, A)).map((q: any) => q.status), ['sent_back']);
  await sql`update cb.questions set status = 'delivered' where id = ${ids.a.q}`;
  assert.deepEqual(await call(sql, 'questions_asked', 'W1@a', true, A), []);
});

test('released: the tasks a finished one held, with where each stands; scoped', async () => {
  const sql = await db(); const ids = await seed(sql);
  await sql`select cb.task_block(${String(ids.a.next)}, ${String(ids.a.doing)}, 'W1@a')`;
  await sql`select cb.task_block(${String(ids.b.next)}, ${String(ids.b.doing)}, 'W1@b')`;
  const r = await call(sql, 'released', ids.a.doing, null);
  assert.deepEqual(r, [{ id: ids.a.next, status: 'blocked', blocked_on: null, waits: [ids.a.doing] }]);
  assert.deepEqual(await call(sql, 'released', ids.b.doing, A), []);
  assert.equal((await call(sql, 'released', ids.b.doing, null)).length, 1);
  assert.deepEqual(await call(sql, 'released', 9999, null), []);
});

test('user_get and users_overview: the name exactly as given; what each person has open', async () => {
  const sql = await db(); const ids = await seed(sql);
  await sql`select cb.user_add('omar', 'Omar'), cb.user_add('zed', 'Zed', 'ahmed', 'admin')`;
  await sql`select cb.ensure_project('a'), cb.user_project_add('omar', 'a', 'ahmed')`;
  await sql`select cb.question_assign(${String(ids.a.q)}, 'omar', 'ahmed')`;
  assert.deepEqual(await call(sql, 'user_get', 'omar'), { name: 'omar', display: 'Omar', role: 'member' });
  assert.equal(await call(sql, 'user_get', 'Omar'), null, 'no case folding: cb assign must keep refusing "Omar"');
  assert.equal(await call(sql, 'user_get', 'nobody'), null);
  assert.deepEqual(await call(sql, 'users_overview'), [
    { name: 'omar', display: 'Omar', role: 'member', open_questions: 1, open_tasks: 0 },
    { name: 'zed', display: 'Zed', role: 'admin', open_questions: 0, open_tasks: 0 }]);
});

test('huddle_show: the huddle, its lines in order, its members; scoped', async () => {
  const sql = await db(); const ids = await seed(sql);
  const h = await call(sql, 'huddle_show', ids.a.h, null);
  assert.equal(h.huddle.topic, 'topic a'); assert.equal(h.huddle.project, 'a'); assert.equal(h.huddle.status, 'open');
  assert.deepEqual(h.members.sort(), ['W1@a', 'W2@a']);
  assert.equal(h.lines.at(-1).summary, 'line in a'); assert.equal(h.lines.at(-1).actor, 'W1@a'); assert.ok(h.lines.at(-1).at);
  assert.equal(await call(sql, 'huddle_show', ids.b.h, A), null);
  assert.equal(await call(sql, 'huddle_show', 9999, null), null);
  assert.equal((await call(sql, 'huddle_show', ids.a.h, A)).huddle.id, ids.a.h);
});

test('session_at, session_of, session_show: a pane, a name, and what a name has open; scoped', async () => {
  const sql = await db(); const ids = await seed(sql);
  assert.deepEqual(await call(sql, 'session_at', 'a-box', 'p1'), { actor: 'W1@a', project: 'a', live: true });
  assert.equal(await call(sql, 'session_at', 'a-box', 'nope'), null);
  await sql`update cb.sessions set last_seen = now() - interval '5 minutes' where machine = 'b-box'`;
  assert.deepEqual(await call(sql, 'session_at', 'b-box', 'p1'), { actor: 'W1@b', project: 'b', live: false });

  assert.deepEqual(await call(sql, 'session_of', 'W1@a', null), { project: 'a', live: true });
  assert.deepEqual(await call(sql, 'session_of', 'W1@b', null), { project: 'b', live: false });
  assert.equal(await call(sql, 'session_of', 'W1@b', A), null);
  assert.equal(await call(sql, 'session_of', 'nobody', null), null);
  await sql`insert into cb.sessions (machine, pane, actor) values ('a-box', 'p9', 'relay@a')`; // a relay's row before cb iam
  assert.deepEqual(await call(sql, 'session_of', 'relay@a', null), { project: null, live: true });
  assert.equal(await call(sql, 'session_of', 'relay@a', A), null, 'a session with no project is in no scope');

  const s = await call(sql, 'session_show', 'W1@a', null);
  assert.deepEqual(s.tasks.map((t: any) => t.id), [ids.a.doing]);
  assert.deepEqual(Object.keys(s.tasks[0]).sort(), ['id', 'priority', 'project', 'status', 'title', 'type']);
  assert.deepEqual(s.questions, [{ id: ids.a.q, status: 'open', body: 'question in a' }]);
  assert.ok(s.events.length >= 3 && s.events.length <= 10);
  assert.deepEqual(Object.keys(s.events[0]).sort(), ['at', 'kind', 'summary', 'task_id']);
  const hidden = await call(sql, 'session_show', 'W1@b', A);
  assert.deepEqual(hidden, { tasks: [], questions: [], events: [] });
});

test('question_peek and question_parents: what a follow-up hangs on, and who it is with; scoped', async () => {
  const sql = await db(); const ids = await seed(sql);
  await sql`select cb.user_add('omar', 'Omar')`;
  await sql`select cb.ensure_project('a'), cb.user_project_add('omar', 'a', 'ahmed')`;
  const f = Number((await sql`select cb.ask(project => 'a', body => 'then what?', actor => 'W1@a', parent => ${String(ids.a.q)}, if_answer => 'Yes', to_user => 'omar') as id`)[0].id);
  assert.deepEqual(await call(sql, 'question_peek', f, null), { id: f, parent_id: ids.a.q, if_answer: 'Yes', assigned_display: 'Omar' });
  assert.deepEqual(await call(sql, 'question_peek', ids.a.q, null), { id: ids.a.q, parent_id: null, if_answer: null, assigned_display: null });
  assert.equal(await call(sql, 'question_peek', ids.b.q, A), null);
  assert.equal(await call(sql, 'question_peek', 9999, null), null);

  const both = [ids.a.q, ids.b.q, 9999];
  assert.deepEqual(await call(sql, 'question_parents', both, null),
    [{ id: ids.a.q, body: 'question in a', answer: null }, { id: ids.b.q, body: 'question in b', answer: null }]);
  assert.deepEqual((await call(sql, 'question_parents', both, A)).map((q: any) => q.id), [ids.a.q]);
  assert.deepEqual(await call(sql, 'question_parents', [], null), []);
});

const NO_WATCH = /only Ahmed adds or removes watched repos: ask him to \(cb ask\), saying which repo and why/;
const NO_MUTE = /only Ahmed mutes or unmutes GitHub logins: ask him to \(cb ask\), saying which login and why/;

test('github watch: only the dashboard; a new repo starts now; adding again changes only what was given', async () => {
  const sql = await db(); const R = 'TachyHealth/iHop-Platform';
  await sql`select cb.ensure_project('ihop'), cb.ensure_project('other')`;
  for (const run of [(tx: any) => tx`select cb.github_watch(${R})`, (tx: any) => tx`select cb.github_unwatch(${R})`]) {
    const e: any = await asSession(sql, run).then(() => null, (x: any) => x);
    assert.match(e.message, NO_WATCH); assert.doesNotMatch(e.message, /cb-web|PGAPPNAME|dashboard/);
  }
  assert.deepEqual(await call(sql, 'github_list'), { repos: [], muted: [] });

  const v = await call(sql, 'github_watch', R, null, null);
  assert.match(v.since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(Math.abs(Date.parse(v.since) - Date.now()) < 60_000);
  assert.deepEqual({ ...v, since: 0 }, { since: 0, to: 'orch@shaltoot', project: 'ihop', last_ok: null, last_error: null, prs: {} });

  await sql`update cb.settings set value = value || '{"since":"2026-01-01T00:00:00.000Z","prs":{"7":12}}' where key = ${'github:' + R}`;
  const again = await call(sql, 'github_watch', R, 'orch@macbook', null);
  assert.deepEqual(again, { since: '2026-01-01T00:00:00.000Z', to: 'orch@macbook', project: 'ihop', last_ok: null, last_error: null, prs: { 7: 12 } });
  assert.equal((await call(sql, 'github_watch', R, null, 'other')).to, 'orch@macbook', 'a project alone leaves who is told');
  assert.equal((await call(sql, 'github_watch', R, null, null)).project, 'other', 'nothing given changes nothing');
  await assert.rejects(call(sql, 'github_watch', 'TachyHealth/x', null, 'nope'), /unknown project/);
  for (const bad of ['../..', '.github/x', 'TachyHealth/..', 'not a repo', 'a/b/c'])
    await assert.rejects(call(sql, 'github_watch', bad, null, null), /is not owner\/repo/, bad);

  await sql`insert into cb.settings (key, value) values ('github:outbox:1', '{}')`;
  const list = await call(sql, 'github_list');
  assert.deepEqual(list.repos.map((r: any) => r.key), ['github:' + R]);
  assert.equal(list.repos[0].value.project, 'other');

  await call(sql, 'github_unwatch', R);
  assert.deepEqual((await call(sql, 'github_list')).repos, []);
  await assert.rejects(call(sql, 'github_unwatch', R), /TachyHealth\/iHop-Platform is not watched: cb github lists the repos/);
});

test('github mute: only the dashboard; lowercase, once, sorted; unmuting someone not muted says so', async () => {
  const sql = await db();
  const e: any = await asSession(sql, (tx) => tx`select cb.github_mute('shaltut')`).then(() => null, (x: any) => x);
  assert.match(e.message, NO_MUTE); assert.doesNotMatch(e.message, /cb-web|PGAPPNAME|dashboard/);
  assert.deepEqual(await call(sql, 'github_mute', 'shaltut', true), ['shaltut']);
  assert.deepEqual(await call(sql, 'github_mute', 'Shaltut', true), ['shaltut']);
  assert.deepEqual(await call(sql, 'github_mute', 'abot', true), ['abot', 'shaltut']);
  assert.deepEqual((await call(sql, 'github_list')).muted, ['abot', 'shaltut']);
  assert.deepEqual(await call(sql, 'github_mute', 'SHALTUT', false), ['abot']);
  await assert.rejects(call(sql, 'github_mute', 'shaltut', false), /shaltut is not muted: cb github lists the muted logins/);
  await assert.rejects(call(sql, 'github_mute', 'not a login', true), /is not a GitHub login/);
});

test('the schema can be applied again over these functions', async () => {
  const sql = await db();
  const { execFileSync } = await import('node:child_process');
  execFileSync('node', ['db/setup.ts', '--test'], { stdio: 'pipe' });
  assert.equal(await call(sql, 'task_peek', 1, null), null);
});

test('the CLI holds no SQL of its own, and its reads are not served over HTTP', async () => {
  const sql = await db(); const ids = await seed(sql);
  const src = readFileSync('cli/cb.ts', 'utf8');
  assert.doesNotMatch(src, /\b(sql|tx)`/, 'a raw statement in cli/cb.ts: make it a cb.* function');
  assert.doesNotMatch(src, /sql\.(begin|unsafe)\b/);

  const rpc: any = await import('../server/rpc.ts');
  serverSql = (await import('../server/db.ts')).sql;
  assert.ok(rpc.CLI_FUNCTIONS.length >= 20);
  for (const fn of rpc.CLI_FUNCTIONS) assert.ok(!rpc.RPC_FUNCTIONS.includes(fn), `${fn} must stay off /api/rpc`);
  const have = new Set((await sql`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'cb'`).map((r: any) => r.proname));
  for (const fn of [...rpc.RPC_FUNCTIONS, ...rpc.CLI_FUNCTIONS]) assert.ok(have.has(fn), `cb.${fn} is listed but not in the schema`);

  await assert.rejects(rpc.callFn('task_show', { id: ids.a.doing }), (e: any) => e.status === 404);
  assert.equal((await rpc.callCli('task_show', { id: ids.a.doing })).title, 'doing in a');
  assert.equal(await rpc.callCli('task_show', { id: ids.b.doing, scope: ['a'] }), null);
  assert.equal((await rpc.callCli('mine', { actor: 'W1@a' })).length, 1, 'callCli still reaches the shared functions');

  // Scoped or knowingly not: a new CLI read must take scope, or be added here with a reason.
  const SCOPE_FREE = ['session_at', 'user_get', 'users_overview', 'github_list', 'github_watch', 'github_unwatch', 'github_mute', 'read_project', 'resolve'];
  const scoped = new Set((await sql`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'cb' and 'scope' = any(p.proargnames)`).map((r: any) => r.proname));
  for (const fn of rpc.CLI_FUNCTIONS) assert.ok(scoped.has(fn) !== SCOPE_FREE.includes(fn), `${fn}: takes scope, or is on the scope-free list (not both, not neither)`);
});
