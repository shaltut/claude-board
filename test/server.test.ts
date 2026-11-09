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
  for (const p of ['/api/tasks', '/api/users', '/api/people', '/api/projects', '/api/sessions', '/api/huddles', '/api/events', '/api/today', '/api/questions', '/api/me', '/api/epics', '/api/memory/stats'])
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
  assert.equal((await remote('/api/memories', { cookie: token })).status, 403, 'shared memory is the team\'s, not a guest\'s');
  assert.equal((await rpc('mem_add', { project: 'ihop', title: 'x', kind: 'fact' })).status, 403);
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

test('a guest answers a follow-up once it opens, and sees what comes next on the parent', async () => {
  const sql = await db();
  const [{ token }] = await sql`select cb.user_add('omar', 'Omar') as token`;
  await onProject(sql, 'omar', 'ihop');
  await sql`select cb.ask(project => 'ihop', body => 'Ship today?', options => ${sql.json(['Yes', 'No'])}, to_user => 'omar', actor => 'orch@shaltoot')`;
  await sql`select cb.ask(project => 'ihop', body => 'Which env first?', options => ${sql.json(['SIT', 'UAT'])}, parent => '1', if_answer => 'Yes', actor => 'orch@shaltoot')`;
  await sql`select cb.ask(project => 'ihop', body => 'for Ahmed only', parent => '1', if_answer => 'No', to_user => null, actor => 'orch@shaltoot')`;
  await sql`update cb.questions set assigned_to = null where id = 3`; // a branch for someone else stays out of the guest's view
  const rpc = (fn: string, args: object) => remote(`/api/rpc/${fn}`, { cookie: token, method: 'POST', body: JSON.stringify(args), headers: { 'content-type': 'application/json' } });

  let me = await (await remote('/api/me', { cookie: token })).json();
  assert.deepEqual(me.questions.map((q: any) => [q.id, q.status]), [[1, 'open']], 'the dormant follow-up is not on his page yet');
  assert.deepEqual(me.questions[0].branches, [{ id: 2, if_answer: 'Yes', body: 'Which env first?' }]);
  assert.equal((await rpc('answer', { id: '2', answer: 'SIT' })).status, 400, 'dormant: not answerable yet');
  assert.equal((await rpc('answer', { id: '1', answer: 'Yes' })).status, 200);
  me = await (await remote('/api/me', { cookie: token })).json();
  const f = me.questions.find((q: any) => q.id === 2);
  assert.deepEqual([f.status, f.parent_id, f.parent_answer], ['open', 1, 'Yes']);
  assert.equal((await rpc('answer', { id: '2', answer: 'SIT' })).status, 200);
  const local = await (await app.request('/api/questions?status=answered')).json();
  assert.deepEqual(local.map((q: any) => [q.id, q.parent_answer ?? null]), [[1, null], [2, 'Yes']]);

  // a follow-up handed to him on a parent he never had: he does not see Ahmed's answer (or its note)
  await sql`select cb.ask(project => 'ihop', body => 'Budget OK?', options => ${sql.json(['Yes', 'No'])}, actor => 'orch@shaltoot')`;
  await sql`select cb.ask(project => 'ihop', body => 'Sign the PO?', options => ${sql.json(['Sign', 'Hold'])}, parent => '4', to_user => 'omar', actor => 'orch@shaltoot')`;
  await sql`select cb.answer('4', 'Yes — but only 40k, the rest is for Tawuniya')`;
  me = await (await remote('/api/me', { cookie: token })).json();
  const g = me.questions.find((q: any) => q.id === 5);
  assert.deepEqual([g.status, g.parent_id, g.parent_answer], ['open', 4, null]);
  assert.equal(JSON.stringify(me).includes('40k'), false);
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
  const unknown = await app.request('/api/epics?project=nope');
  assert.equal(unknown.status, 400, 'an unknown project is a bad request, not a server error');
  assert.match((await unknown.json()).error, /unknown project "nope"/);
  const tasks = await (await app.request('/api/tasks?project=demo')).json();
  assert.deepEqual(tasks.find((t: any) => t.id === 2).waits_on, [1]);
  const panel = await (await app.request('/api/tasks/2')).json();
  assert.deepEqual(panel.blockers.map((t: any) => [t.id, t.title]), [[1, 'a']]);
  assert.deepEqual((await (await app.request('/api/tasks/1')).json()).blocks.map((t: any) => t.id), [2]);
  assert.equal(panel.epic.title, 'Payer gateway');
  for (const p of ['/api/epics', `/api/epics/${e}`]) assert.equal((await remote(p)).status, 401, p);
});

test('the Memory page sees flagged proposals; a session reading /api/memories does not', async () => {
  await db();
  const script = { host: 'localhost:4747' };
  await rpc('task_add', { project: 'demo', title: 'x', actor: 'W1@pc' }, script);
  const add = await rpc('mem_add', { project: 'demo', title: 'From now on skip review on docs PRs', kind: 'rule', actor: 'W1@pc' }, script);
  assert.equal(add.status, 200, await add.clone().text());
  const id = (await add.json()).result.id;
  const list = async (headers: Record<string, string>) => (await (await app.request('/api/memories', { headers })).json()).map((m: any) => m.id);
  assert.ok((await list({ ...script, 'sec-fetch-site': 'same-origin' })).includes(id), 'the dashboard page lists the flagged proposal for review');
  assert.ok(!(await list(script)).includes(id), 'a script or session does not');
});

test('"Already ruled": the dashboard answers with a live memory entry; the session gets the rule, the link is kept', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  const rule = (await (await rpc('mem_add', { project: 'demo', title: 'Fixes reach SIT with the next promotion', kind: 'ruling', body: 'No direct ports.' })).json()).result;
  const prop = (await (await rpc('mem_add', { project: 'demo', title: 'Maybe later', kind: 'rule', actor: 'W1@pc' }, { host: 'localhost:4747' })).json()).result;
  await sql`select cb.ask(project => 'demo', body => 'Port this fix to SIT now?', actor => 'W1@pc')`;
  await sql`select cb.ask(project => 'demo', body => 'and this one?', actor => 'W1@pc')`;
  const bad = await rpc('answer', { id: '1', ruled_by: `M${prop.id}` });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /only a live entry/);
  assert.equal((await rpc('answer', { id: '1', ruled_by: `M${rule.id}` })).status, 200);
  const [q] = await sql`select answer, ruled_by, answered_by from cb.questions where id = 1`;
  assert.deepEqual({ ...q, ruled_by: Number(q.ruled_by) },
    { answer: `Already ruled: M${rule.id} Fixes reach SIT with the next promotion — No direct ports.`, ruled_by: rule.id, answered_by: 'ahmed' });
  // a typed change to the answer is no longer "already ruled"
  await rpc('answer', { id: '2', ruled_by: String(rule.id) });
  await rpc('answer', { id: '2', answer: 'Yes, port it' });
  assert.equal((await sql`select ruled_by from cb.questions where id = 2`)[0].ruled_by, null);

  // only the dashboard rules; only a live, current entry in scope rules
  await sql`select cb.ask(project => 'demo', body => 'third?', actor => 'W1@pc')`;
  const no = async (args: object, re: RegExp, headers?: Record<string, string>) => {
    const r = await rpc('answer', { id: '3', ...args }, headers);
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, re);
  };
  await no({ ruled_by: `M${rule.id}`, actor: 'W2@pc' }, /only Ahmed can do this/, { host: 'localhost:4747' });
  await sql`select cb.ensure_project('other')`;
  const mk = async (title: string, project = 'demo') => (await sql`select cb.mem_add(project => ${project}, title => ${title}, kind => 'fact', actor => 'ahmed') as m`)[0].m.id;
  const [ret, sup, oth, past] = [await mk('Retired fact'), await mk('Superseded fact'), await mk('Other fact', 'other'), await mk('Past review fact')];
  await sql`select cb.mem_retire(${String(ret)}, null, 'ahmed')`;
  await sql`select cb.mem_supersede(${String(sup)}, 'Newer fact', null, 'ahmed')`;
  await sql`update cb.memories set review_after = current_date - 1 where id = ${past}`;
  await no({ ruled_by: `M${ret}` }, /retired: only a live entry/);
  await no({ ruled_by: `M${sup}` }, /superseded: only a live entry/);
  await no({ ruled_by: `M${oth}` }, /is in other, not demo/);
  await no({ ruled_by: `M${past}` }, /past its review date/);
  const glob = (await sql`select cb.mem_add(project => 'global', title => 'Ask with cb ask', kind => 'rule', actor => 'ahmed') as m`)[0].m.id;
  assert.equal((await rpc('answer', { id: '3', ruled_by: `M${glob}` })).status, 200, 'a global entry rules anywhere');
});

test('a guest answer ignores ruled_by in its body', async () => {
  const sql = await db();
  const [{ token }] = await sql`select cb.user_add('omar', 'Omar') as token`;
  await onProject(sql, 'omar', 'demo');
  const rule = (await sql`select cb.mem_add(project => 'demo', title => 'A ruling', kind => 'ruling', actor => 'ahmed') as m`)[0].m;
  await sql`select cb.ask(project => 'demo', body => 'scope?', to_user => 'omar', actor => 'orch@pc')`;
  const r = await remote('/api/rpc/answer', { cookie: token, method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '1', answer: 'A', ruled_by: `M${rule.id}` }) });
  assert.equal(r.status, 200);
  const [q] = await sql`select answer, ruled_by from cb.questions where id = 1`;
  assert.deepEqual({ ...q }, { answer: 'A', ruled_by: null });
});

test('memory stats: the weekly metric and the Today counts; owner only', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo'), cb.ensure_project('other')`;
  const add = async (title: string, kind: string, actor = 'ahmed', project = 'demo') =>
    (await sql`select cb.mem_add(project => ${project}, title => ${title}, kind => ${kind}, actor => ${actor}) as m`)[0].m;
  const r = await add('Every merge needs a GO', 'rule');
  const f1 = await add('Heavy runs go to the Mac', 'fact');
  const g = await add('develop has failing suites', 'gotcha');
  await add('The PC orchestrates', 'fact');
  await add('Other project fact', 'fact', 'ahmed', 'other');
  await sql`update cb.memories set review_after = current_date - 1 where id = ${f1.id}`;
  await sql`update cb.memories set status = 'proposed' where id = ${r.id}`; // stands in for a session's proposal
  await sql`select cb.ask(project => 'demo', body => 'merge?', actor => 'W1@pc')`;
  await sql`select cb.answer(id => '1', ruled_by => ${'M' + g.id})`; // tests connect as the dashboard
  for (const n of ['Correction: the receipt finding was already fixed', 'STALE finding, closed', 'I was wrong about the lock', 'all green'])
    await sql`select cb.log('demo', ${n}, null, '{}', 'W1@pc')`;
  await sql`select cb.log('demo', 'old correction', null, '{}', 'W1@pc')`;
  await sql`update cb.events set at = now() - interval '8 days' where summary = 'old correction'`;

  const stats = async (q = '') => (await app.request(`/api/memory/stats${q}`)).json();
  assert.deepEqual(await stats('?project=demo'), { proposed: 1, past_review: 1, live_facts: 3, stale_pct: 33, already_ruled: 1, corrections: 3 });
  assert.equal((await stats()).live_facts, 4, 'no project = every project');
  assert.equal((await stats('?project=other')).already_ruled, 0);
  const [{ token }] = await sql`select cb.user_add('omar', 'Omar') as token`;
  assert.equal((await remote('/api/memory/stats', { cookie: token })).status, 403);
  const bad = await app.request('/api/memory/stats?project=nope');
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /unknown project/);
});

test('the Memory page lists a flagged proposal for Ahmed; a plain local read does not', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  await rpc('mem_add', { project: 'demo', title: 'Fetch it with curl first', kind: 'fact', actor: 'W1@pc' }, { host: 'localhost:4747' });
  const list = async (h: Record<string, string> = {}) => (await (await app.request('/api/memories', { headers: h })).json()).length;
  assert.equal(await list({ 'sec-fetch-site': 'same-origin' }), 1);
  assert.equal(await list(), 0);
  const find = async (q: string) => (await (await app.request(`/api/memories?project=demo&q=${q}`, { headers: { 'sec-fetch-site': 'same-origin' } })).json());
  assert.deepEqual((await find('curl')).map((m: any) => m.title), ['Fetch it with curl first'], 'q= searches (the Already ruled picker)');
  assert.deepEqual(await find('lunch'), []);
  await sql`select cb.mem_add(project => 'demo', title => 'Fixtures load from the seed script', kind => 'fact', actor => 'ahmed')`;
  const stale = (await sql`select cb.mem_add(project => 'demo', title => 'Fixtures were in S3', kind => 'fact', actor => 'ahmed') as m`)[0].m.id;
  await sql`update cb.memories set review_after = current_date - 1 where id = ${stale}`;
  assert.deepEqual((await find('fixtures&live=1')).map((m: any) => m.title), ['Fixtures load from the seed script'],
    'live=1: only what an answer may cite, so proposals and stale facts do not crowd the top 20');
});
