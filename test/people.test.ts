import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.ts'; // sets CB_DATABASE_URL before the server's db client loads

const { app } = await import('../server/main.ts');
const { sql: serverSql } = await import('../server/db.ts');

const clients: any[] = [];
after(() => Promise.all([...clients.map((c) => c.end()), serverSql.end()]));
async function db() { const s = await freshDb(); clients.push(s); return s; }

const DASHBOARD = { host: 'localhost:4747', origin: 'http://localhost:4747' };
const rpc = (fn: string, args: object, headers: Record<string, string> = DASHBOARD) =>
  app.request(`/api/rpc/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(args) });
const remote = (path: string, init: RequestInit & { cookie?: string } = {}) =>
  app.request(path, { ...init, headers: { 'x-forwarded-for': '1.2.3.4', host: 'abc.ngrok-free.app',
    ...(init.cookie ? { cookie: `cb_user=${init.cookie}` } : {}), ...(init.headers as any) } });

test('People: only this PC reads the tokens; a guest or a stranger never does', async () => {
  const sql = await db();
  const [{ token }] = await sql`select cb.user_add('omar', 'Omar') as token`;
  await sql`select cb.ask(project => 'ihop', body => 'E1 scope?', blocking => true, to_user => 'omar', actor => 'orch@shaltoot')`;

  const local = await (await app.request('/api/people')).json();
  assert.equal(local.people[0].token, token);
  assert.equal(local.people[0].name, 'omar');

  assert.equal((await remote('/api/people')).status, 401);
  assert.equal((await remote('/api/people', { cookie: token })).status, 403);
  const post = (fn: string) => remote(`/api/rpc/${fn}`, { cookie: token, method: 'POST', body: JSON.stringify({ name: 'omar' }), headers: { 'content-type': 'application/json' } });
  for (const fn of ['user_rotate', 'user_remove', 'user_add']) assert.equal((await post(fn)).status, 403, fn);
  for (const p of ['/api/me', '/api/whoami']) assert.doesNotMatch(await (await remote(p, { cookie: token })).text(), new RegExp(token), p);
  assert.deepEqual(await (await app.request('/api/users')).json(), [{ name: 'omar', display: 'Omar' }], '/api/users stays name and display only');
});

test('People: what waits on each person, and when they last answered or wrote', async () => {
  const sql = await db();
  await sql`select cb.user_add('omar', 'Omar'), cb.user_add('iman', 'Iman')`;
  await sql`select cb.ask(project => 'ihop', body => 'E1 scope?', blocking => true, task_id => null, to_user => 'omar', actor => 'orch@shaltoot')`;
  await sql`select cb.ask(project => 'ihop', body => 'Launch date?', to_user => 'omar', actor => 'orch@shaltoot')`;
  await sql`select cb.ask(project => 'ihop', body => 'Answered one', to_user => 'omar', actor => 'orch@shaltoot')`;
  await sql`select cb.answer('3', 'yes', 'omar')`;
  await sql`select cb.task_add(project => 'ihop', title => 'PO sign-off', assignee => 'omar')`;
  await sql`select cb.task_add(project => 'ihop', title => 'old', assignee => 'omar', status => 'done')`;

  const { people, public_url } = await (await app.request('/api/people', { headers: { host: 'localhost:4747' } })).json();
  assert.equal(typeof public_url === 'string' || public_url === null, true);
  const omar = people.find((p: any) => p.name === 'omar'), iman = people.find((p: any) => p.name === 'iman');
  assert.deepEqual(omar.questions.map((q: any) => [q.body, q.blocking]), [['E1 scope?', true], ['Launch date?', false]]);
  assert.deepEqual(omar.tasks.map((t: any) => t.title), ['PO sign-off']);
  assert.ok(omar.last_active, 'his answer counts as activity');
  assert.deepEqual([iman.questions, iman.tasks, iman.last_active], [[], [], null]);
});

test('People: a new link stops the old one, in a fresh browser and in a signed-in one', async () => {
  const sql = await db();
  const [{ token: old }] = await sql`select cb.user_add('omar', 'Omar') as token`;
  assert.equal((await remote(`/?u=${old}`)).status, 302);

  const res = await rpc('user_rotate', { name: 'omar' });
  assert.equal(res.status, 200);
  const fresh = (await res.json()).result;
  assert.ok(fresh && fresh !== old);

  assert.equal((await remote(`/?u=${old}`)).status, 401, 'the old link');
  assert.equal((await remote('/api/me', { cookie: old })).status, 401, 'a browser signed in with the old link');
  assert.equal((await remote(`/?u=${fresh}`)).status, 302);
  assert.equal((await remote('/api/me', { cookie: fresh })).status, 200);

  assert.equal((await rpc('user_rotate', { name: 'nobody' })).status, 400);
});

test('People: removing a person hands their open questions back to Ahmed and unassigns their open tasks', async () => {
  const sql = await db();
  const [{ token }] = await sql`select cb.user_add('omar', 'Omar') as token`;
  await sql`select cb.task_add(project => 'ihop', title => 'PO sign-off', assignee => 'omar', status => 'review')`;
  await sql`select cb.task_add(project => 'ihop', title => 'old', assignee => 'omar', status => 'done')`;
  await sql`select cb.ask(project => 'ihop', body => 'open one', blocking => true, task_id => '1', to_user => 'omar', actor => 'orch@shaltoot')`;
  await sql`select cb.ask(project => 'ihop', body => 'answered one', to_user => 'omar', actor => 'orch@shaltoot')`;
  await sql`select cb.answer('2', 'yes', 'omar')`;

  const res = await rpc('user_remove', { name: 'omar', actor: 'ahmed' }); // as the dashboard's rpc() sends it
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).result, { questions: 1, tasks: 1 });

  const qs = await sql`select body, status, assigned_to, answered_by from cb.questions order by id`;
  assert.deepEqual(qs.map((q) => ({ ...q })), [
    { body: 'open one', status: 'open', assigned_to: null, answered_by: null },
    { body: 'answered one', status: 'answered', assigned_to: null, answered_by: 'omar' }]);
  const ts = await sql`select title, status, assignee from cb.tasks order by id`;
  assert.deepEqual(ts.map((t) => ({ ...t })), [
    { title: 'PO sign-off', status: 'blocked', assignee: null }, // still held on Q1, which now waits on Ahmed
    { title: 'old', status: 'done', assignee: 'omar' }]);
  const [ev] = await sql`select actor, summary from cb.events where task_id = 1 and kind = 'updated' order by id desc limit 1`;
  assert.deepEqual({ ...ev }, { actor: 'ahmed', summary: 'unassigned: Omar was removed' });

  assert.equal((await sql`select 1 from cb.users`).length, 0);
  assert.equal((await remote(`/?u=${token}`)).status, 401);
  assert.equal((await remote('/api/me', { cookie: token })).status, 401);
  assert.equal((await rpc('user_remove', { name: 'omar' })).status, 400, 'already gone');
});

test('People: a session cannot rotate or remove as ahmed', async () => {
  const sql = await db();
  await sql`select cb.user_add('omar', 'Omar')`;
  const script = { host: 'localhost:4747' };
  for (const fn of ['user_rotate', 'user_remove', 'user_add']) {
    const r = await rpc(fn, { name: 'omar', actor: 'ahmed' }, script);
    assert.equal(r.status, 400, fn);
    assert.match((await r.json()).error, /only Ahmed's dashboard can act as ahmed/);
  }
  assert.equal((await sql`select 1 from cb.users`).length, 1);
});
