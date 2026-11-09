import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, onProject } from './helpers.ts'; // sets CB_DATABASE_URL before the server's db client loads

const { app } = await import('../server/main.ts');
const { sql: serverSql } = await import('../server/db.ts');

const clients: any[] = [];
after(() => Promise.all([...clients.map((c) => c.end()), serverSql.end()]));
async function db() { const s = await freshDb(); clients.push(s); return s; }

// The dashboard's fetch: a browser POST always carries Origin.
const DASHBOARD = { host: 'localhost:4747', origin: 'http://localhost:4747' };
const rpc = (fn: string, args: object, headers: Record<string, string> = DASHBOARD) =>
  app.request(`/api/rpc/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(args) });

test('only the dashboard page acts as ahmed: a script POSTing without Origin is a session', async () => {
  await db();
  const script = { host: 'localhost:4747' }; // curl from a session: local, no Origin
  const forged = await rpc('task_add', { project: 'demo', title: 'x', actor: 'ahmed' }, script);
  assert.equal(forged.status, 400);
  assert.match((await forged.json()).error, /only Ahmed's dashboard can act as ahmed/);
  assert.equal((await rpc('task_add', { project: 'demo', title: 'x', actor: 'W1@pc' }, script)).status, 200, 'its own name is fine');
  assert.equal((await rpc('task_add', { project: 'demo', title: 'x', actor: 'ahmed' })).status, 200);
});

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

test('the dashboard huddle flow over rpc: Ahmed opens, talks, turns a line into a linked task, closes', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'ihop', title => 'seed')`;
  await sql`select cb.iam('pc', 'w2:p2', 'orch@shaltoot', 'ihop')`;
  const ok = async (fn: string, args: object) => { const j = await (await rpc(fn, { actor: 'ahmed', ...args })).json(); assert.ok(j.ok, j.error); return j.result; };
  const id = await ok('huddle_open', { topic: 'Rollout plan', members: ['orch@shaltoot'], task: null, project: 'ihop' });
  await ok('huddle_say', { id, message: 'line one\nline two' });
  const tid = await ok('task_add', { project: 'ihop', title: 'line one', body: 'from huddle', status: 'next', priority: 'P2', links: { huddle: `#${id}` } });
  await ok('huddle_say', { id, message: `created #${tid} from ahmed's line at 10:00` });
  await ok('huddle_close', { id, summary: 'ship Monday' });
  const h = await (await app.request(`/api/huddles/${id}`)).json();
  assert.deepEqual(h.members, ['ahmed', 'orch@shaltoot']);
  assert.deepEqual(h.lines.map((l: any) => [l.actor, l.action, l.summary]), [
    ['ahmed', 'open', 'opened: Rollout plan'], ['ahmed', 'say', 'line one\nline two'],
    ['ahmed', 'say', `created #${tid} from ahmed's line at 10:00`], ['ahmed', 'close', 'closed: ship Monday']]);
  const [t] = await sql`select links from cb.tasks where id = ${tid}`;
  assert.deepEqual(t.links, { huddle: `#${id}` });
});

// Guests reach the board through a tunnel: default-deny, then only their own items.
const remote = (path: string, init: RequestInit & { cookie?: string } = {}) =>
  app.request(path, { ...init, headers: { 'x-forwarded-for': '1.2.3.4', host: 'abc.ngrok-free.app',
    ...(init.cookie ? { cookie: `cb_user=${init.cookie}` } : {}), ...(init.headers as any) } });

test('through a tunnel, nothing is readable or writable without a user link', async () => {
  await db();
  for (const p of ['/api/tasks', '/api/users', '/api/people', '/api/projects', '/api/sessions', '/api/huddles', '/api/events', '/api/today', '/api/questions', '/api/me', '/api/epics'])
    assert.equal((await remote(p)).status, 401, p);
  assert.equal((await remote('/api/rpc/task_add', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await remote('/api/whoami')).status, 200);
  assert.deepEqual(await (await remote('/api/whoami')).json(), { role: 'anonymous' });
  // locally everything works as before
  assert.equal((await app.request('/api/tasks')).status, 200);
  assert.deepEqual(await (await app.request('/api/whoami')).json(), { role: 'local' });
});

test('a guest link sets a cookie; the guest sees and answers only what is assigned to them', async () => {
  const sql = await db();
  const [{ token }] = await sql`select cb.user_add('omar', 'Omar') as token`;
  await sql`select cb.user_add('iman', 'Iman')`;
  await onProject(sql, 'omar', 'ihop');
  await onProject(sql, 'iman', 'ihop');
  await sql`select cb.task_add(project => 'ihop', title => 'PO sign-off on E1-E12', assignee => 'omar')`;
  await sql`select cb.task_add(project => 'ihop', title => 'internal')`;
  await sql`select cb.ask(project => 'ihop', body => 'E1 scope?', options => ${sql.json([{ label: 'A' }, { label: 'B' }])}, to_user => 'omar', actor => 'orch@shaltoot')`;
  await sql`select cb.ask(project => 'ihop', body => 'for Ahmed', actor => 'orch@shaltoot')`;
  await sql`select cb.ask(project => 'ihop', body => 'for Iman', to_user => 'iman', actor => 'orch@shaltoot')`;

  const land = await remote(`/?u=${token}`);
  assert.equal(land.status, 302);
  assert.match(land.headers.get('set-cookie') ?? '', /cb_user=[^;]+;.*HttpOnly/i);
  assert.equal((await remote('/api/tasks', { cookie: 'wrong' })).status, 401);
  assert.deepEqual(await (await remote('/api/whoami', { cookie: token })).json(), { role: 'guest', user: { name: 'omar', display: 'Omar' } });

  const me = await (await remote('/api/me', { cookie: token })).json();
  assert.deepEqual(me.questions.map((q: any) => q.body), ['E1 scope?']);
  assert.deepEqual(me.tasks.map((t: any) => t.title), ['PO sign-off on E1-E12']);
  assert.equal((await remote('/api/tasks', { cookie: token })).status, 403, 'guests get no board-wide reads');

  const rpc = (fn: string, args: object) => remote(`/api/rpc/${fn}`, { cookie: token, method: 'POST', body: JSON.stringify(args), headers: { 'content-type': 'application/json' } });
  assert.equal((await rpc('answer', { id: '2', answer: 'x', actor: 'ahmed' })).status, 403, 'not assigned to omar');
  assert.equal((await rpc('answer', { id: '3', answer: 'x' })).status, 403, "iman's question");
  assert.equal((await rpc('task_add', { project: 'ihop', title: 'x' })).status, 403);
  assert.equal((await rpc('log', { project: 'ihop', summary: 'x', task_id: '2' })).status, 403, 'not his task');
  assert.equal((await rpc('answer', { id: '1', answer: 'A', actor: 'ahmed' })).status, 200);
  assert.equal((await rpc('log', { project: 'ihop', summary: 'signed', task_id: '1', actor: 'ahmed' })).status, 200);
  const [q] = await sql`select status, answer, answered_by from cb.questions where id = 1`;
  assert.deepEqual({ ...q }, { status: 'answered', answer: 'A', answered_by: 'omar' }, 'actor is the guest, whatever the body says');
  const [e] = await sql`select actor from cb.events where kind = 'note'`;
  assert.equal(e.actor, 'omar');

  // his note shows back on his task (so it doesn't vanish), but session notes on it stay private
  await sql`select cb.log(project => 'ihop', summary => 'internal session chatter', task_id => '1', actor => 'W2@macbook')`;
  const after = await (await remote('/api/me', { cookie: token })).json();
  assert.deepEqual(after.tasks[0].my_notes.map((n: any) => n.summary), ['signed']);
});

test('a web page on another site cannot drive the board through the browser (CSRF)', async () => {
  await db();
  const post = (origin?: string) => app.request('http://localhost:4747/api/rpc/task_add', {
    method: 'POST', body: JSON.stringify({ project: 'demo', title: 'x' }),
    headers: { 'content-type': 'application/json', host: 'localhost:4747', ...(origin ? { origin } : {}) },
  });
  assert.equal((await post('https://evil.example')).status, 403);
  assert.equal((await post('http://localhost:4747')).status, 200);
  assert.equal((await post()).status, 200); // scripts and curl send no Origin
});

test('a guest sending garbage gets a clean 400, not a server error', async () => {
  const sql = await db();
  const [{ token }] = await sql`select cb.user_add('omar', 'Omar') as token`;
  const post = (body: string) => remote('/api/rpc/answer', { method: 'POST', cookie: token, body, headers: { 'content-type': 'application/json' } });
  assert.equal((await post('null')).status, 400);
  assert.equal((await post(JSON.stringify({ id: 'abc', answer: 'x' }))).status, 400);
});

test('epics over HTTP: the dashboard creates one; lists, epic page and task panel carry progress and blockers', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  const script = { host: 'localhost:4747' };
  assert.equal((await rpc('epic_create', { project: 'demo', title: 'Payer gateway', goal: 'g' }, script)).status, 400, 'a session cannot');
  const res = await rpc('epic_create', { project: 'demo', title: 'Payer gateway', goal: 'g' });
  assert.equal(res.status, 200);
  const e = (await res.json()).result;
  for (const title of ['a', 'b']) await rpc('task_add', { project: 'demo', title, status: 'next', epic: `E${e}` });
  assert.equal((await rpc('task_block', { task: '2', blocker: '1' })).status, 200);
  const [epic] = await (await app.request('/api/epics?project=demo')).json();
  assert.deepEqual([epic.id, epic.total, epic.finished, epic.status], [e, 2, 0, 'open']);
  const page = await (await app.request(`/api/epics/${e}`)).json();
  assert.equal(page.epic.title, 'Payer gateway');
  assert.deepEqual(page.steps.map((t: any) => [t.id, t.status, t.waits_on]), [[1, 'next', []], [2, 'blocked', [1]]]);
  assert.equal((await app.request('/api/epics/999')).status, 404);
  const tasks = await (await app.request('/api/tasks?project=demo')).json();
  assert.deepEqual(tasks.find((t: any) => t.id === 2).waits_on, [1]);
  const panel = await (await app.request('/api/tasks/2')).json();
  assert.deepEqual(panel.blockers.map((t: any) => [t.id, t.title]), [[1, 'a']]);
  assert.deepEqual((await (await app.request('/api/tasks/1')).json()).blocks.map((t: any) => t.id), [2]);
  assert.equal(panel.epic.title, 'Payer gateway');
  for (const p of ['/api/epics', `/api/epics/${e}`]) assert.equal((await remote(p)).status, 401, p);
});
