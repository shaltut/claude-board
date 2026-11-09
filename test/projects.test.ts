import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.ts'; // sets CB_DATABASE_URL before the server's db client loads

const { app } = await import('../server/main.ts');
const { sql: serverSql } = await import('../server/db.ts');

const clients: any[] = [];
after(() => Promise.all([...clients.map((c) => c.end()), serverSql.end()]));
async function db() { const s = await freshDb(); clients.push(s); return s; }

const DASHBOARD = { host: 'localhost:4747', origin: 'http://localhost:4747' };
const SESSION = { host: 'localhost:4747' };
const rpc = (fn: string, args: object, headers: Record<string, string> = DASHBOARD) =>
  app.request(`/api/rpc/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(args) });
const remote = (path: string, init: RequestInit & { cookie?: string } = {}) =>
  app.request(path, { ...init, headers: { 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '1.2.3.4', host: 'board.example.app',
    ...(init.cookie ? { cookie: `cb_user=${init.cookie}` } : {}), ...(init.headers as any) } });
const post = (path: string, body: object, cookie?: string) =>
  remote(path, { method: 'POST', cookie, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

/** omar on ihop; projects ihop and qhs exist. */
async function setup() {
  const sql = await db();
  await sql`select cb.task_add(project => 'ihop', title => 'seed ihop'), cb.task_add(project => 'qhs', title => 'seed qhs')`;
  const [{ token }] = await sql`select cb.user_add('omar', 'Omar') as token`;
  await sql`select cb.user_project_add('omar', 'ihop', 'ahmed')`;
  return { sql, token };
}

/** Rows from before #315: assigned to a person on a project they aren't on (the check would refuse them now). */
async function legacy(sql: any, f: () => Promise<unknown>) {
  await sql`alter table cb.tasks disable trigger tasks_assignee_project`;
  await sql`alter table cb.questions disable trigger questions_assignee_project`;
  try { await f() } finally {
    await sql`alter table cb.tasks enable trigger tasks_assignee_project`;
    await sql`alter table cb.questions enable trigger questions_assignee_project`;
  }
}

test('projects: a question or task goes only to a person on its project', async () => {
  const { sql } = await setup();
  const refused = /omar is not on project qhs/;
  await assert.rejects(sql`select cb.ask(project => 'qhs', body => 'x', to_user => 'omar', actor => 'orch@pc')`, refused);
  await sql`select cb.ask(project => 'ihop', body => 'fine', to_user => 'omar', actor => 'orch@pc')`;
  const [{ q }] = await sql`select cb.ask(project => 'qhs', body => 'for Ahmed', actor => 'orch@pc') as q`;
  await assert.rejects(sql`select cb.question_assign(${String(q)}, 'omar', 'orch@pc')`, refused);
  await assert.rejects(sql`select cb.task_add(project => 'qhs', title => 'x', assignee => 'omar')`, refused);
  await sql`select cb.task_add(project => 'ihop', title => 'fine', assignee => 'omar')`;
  await assert.rejects(sql`select cb.task_update('2', ${sql.json({ assignee: 'omar' })}::jsonb, 'orch@pc')`, refused, 'task #2 is on qhs');
  await sql`select cb.task_add(project => 'qhs', title => 'sessions are not people', assignee => 'W1@pc')`;

  // the live board's omar and iman start with no projects: their old items still move, nothing new reaches them
  await sql`select cb.user_add('iman', 'Iman')`;
  await legacy(sql, () => sql`select cb.task_add(project => 'qhs', title => 'old', assignee => 'iman')`);
  const [{ id }] = await sql`select id::text from cb.tasks where title = 'old'`;
  await sql`select cb.task_move(${id}, 'done', null, 'orch@pc')`;
  await assert.rejects(sql`select cb.task_add(project => 'ihop', title => 'x', assignee => 'iman')`, /iman is not on project ihop/);
});

test('projects: taking a person off a project hands their open work there back', async () => {
  const { sql } = await setup();
  await sql`select cb.ask(project => 'ihop', body => 'q', to_user => 'omar', actor => 'orch@pc')`;
  await sql`select cb.task_add(project => 'ihop', title => 'doing', assignee => 'omar', status => 'in_progress')`;
  const res = await rpc('user_project_remove', { name: 'omar', project: 'ihop', actor: 'ahmed' });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).result, { questions: 1, tasks: 1 });
  const [t] = await sql`select assignee, status from cb.tasks where title = 'doing'`;
  assert.deepEqual({ ...t }, { assignee: null, status: 'next' });
  assert.equal((await sql`select 1 from cb.user_projects`).length, 0);
  const people = await (await app.request('/api/people', { headers: { ...SESSION, 'sec-fetch-site': 'same-origin' } })).json();
  assert.deepEqual(people.people[0].projects, []);
});

test('projects: a guest sees and answers only what is assigned to them on their projects', async () => {
  const { sql, token } = await setup();
  await sql`select cb.ask(project => 'ihop', body => 'mine', to_user => 'omar', actor => 'orch@pc')`;
  await sql`select cb.task_add(project => 'ihop', title => 'my task', assignee => 'omar')`;
  await legacy(sql, async () => {
    await sql`select cb.ask(project => 'qhs', body => 'not my project', to_user => 'omar', actor => 'orch@pc')`;
    await sql`select cb.task_add(project => 'qhs', title => 'not my project either', assignee => 'omar')`;
  });
  const me = await (await remote('/api/me', { cookie: token })).json();
  assert.deepEqual(me.questions.map((q: any) => q.body), ['mine']);
  assert.deepEqual(me.tasks.map((t: any) => t.title), ['my task']);
  const [{ q }] = await sql`select id::text as q from cb.questions where body = 'not my project'`;
  const [{ t }] = await sql`select id::text as t from cb.tasks where title = 'not my project either'`;
  assert.equal((await post('/api/rpc/answer', { id: q, answer: 'x' }, token)).status, 403);
  assert.equal((await post('/api/rpc/log', { task_id: t, summary: 'x' }, token)).status, 403);
  const [{ mq }] = await sql`select id::text as mq from cb.questions where body = 'mine'`;
  assert.equal((await post('/api/rpc/answer', { id: mq, answer: 'yes' }, token)).status, 200);
});

test('login: name and password set the same cookie as the link; a wrong one waits and says nothing more', async () => {
  const { sql, token } = await setup();
  await sql`select cb.user_add('iman', 'Iman')`; // no password
  await sql`select cb.user_password('omar', 'correct horse', 'ahmed')`;
  const [{ password }] = await sql`select password from cb.users where name = 'omar'`;
  assert.match(password, /^\$2[abxy]\$/, 'bcrypt, never the plain text');
  await assert.rejects(sql`select cb.user_password('omar', 'short', 'ahmed')`, /at least 8/);

  const ok = await post('/api/login', { name: ' Omar ', password: 'correct horse' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie') ?? '', new RegExp(`cb_user=${token};.*HttpOnly`, 'i'));
  assert.deepEqual(await (await remote('/api/whoami', { cookie: token })).json(), { role: 'guest', user: { name: 'omar', display: 'Omar' } });

  for (const [name, pw] of [['omar', 'wrong horse'], ['nobody', 'correct horse'], ['iman', ''], ['iman', 'anything at all']]) {
    const t0 = Date.now();
    const bad = await post('/api/login', { name, password: pw });
    assert.equal(bad.status, 401, `${name}/${pw}`);
    assert.deepEqual(await bad.json(), { ok: false, error: "That name and password don't match." });
    assert.equal(bad.headers.get('set-cookie'), null);
    assert.ok(Date.now() - t0 >= 900, 'a failure waits about a second');
  }
  assert.equal((await post('/api/login', {})).status, 401, 'garbage is a failure, not a crash');

  const out = await post('/api/logout', {}, token);
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie') ?? '', /cb_user=;.*Max-Age=0/i);
  assert.equal((await remote(`/?u=${token}`)).status, 302, 'the link still signs in with one click');
});

test('a session cannot set passwords or projects', async () => {
  const { sql } = await setup();
  for (const [fn, args] of [['user_password', { name: 'omar', password: 'correct horse' }], ['user_project_add', { name: 'omar', project: 'qhs' }],
    ['user_project_remove', { name: 'omar', project: 'ihop' }]] as const) {
    const r = await rpc(fn, args, SESSION);
    assert.equal(r.status, 400, fn);
    assert.match((await r.json()).error, /only Ahmed can do this/);
  }
  const [u] = await sql`select password is null as none, (select count(*)::int from cb.user_projects) as n from cb.users`;
  assert.deepEqual({ ...u }, { none: true, n: 1 });
  const page = await (await app.request('/api/people', { headers: { ...SESSION, 'sec-fetch-site': 'same-origin' } })).text();
  assert.doesNotMatch(page, /\$2[abxy]\$/, 'the hash never leaves the database');
});
