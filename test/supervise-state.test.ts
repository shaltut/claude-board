import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));

const SQUAD = {
  machines: { macbook: { herdr: 'macbook', repo: '/Users/me/Work/x', board: '/Users/me/Work/claude-board' } },
  roles: { lead: { count: 1, model: 'opus', machine: 'macbook' }, architect: { count: 1, model: 'opus', machine: 'macbook' },
           builder: { count: 3, model: 'sonnet', machine: 'macbook' }, owner: { model: 'opus', machine: 'macbook' } },
  areas: ['claims'],
};
const conn = (name: string) => { const c = postgres(TEST_URL, { onnotice: () => {}, connection: { application_name: name } }); clients.push(c); return c; };

// sv: pipeline on, supervised squad with an owner for claims
async function setup(squad: any = { ...SQUAD, supervise: true }) {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('sv')`;
  await sql`select cb.project_pipeline('sv', true, 'ahmed')`;
  await sql`select cb.squad_set('sv', ${sql.json(squad)}, 'ahmed')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('macbook','p1','sv-B1@macbook','sv','builder'), ('macbook','p2','sv-B2@macbook','sv','builder')`;
  return { sql, sup: conn('cb-supervisor/test') };
}
// a card in a stage, nobody holding it
async function card(sql: any, o: { stage?: string | null; type?: string; labels?: string[]; assignee?: string | null } = {}) {
  const [{ id }] = await sql`select cb.task_add(project => 'sv', title => 'c', type => ${o.type ?? 'bug'}, status => 'next', actor => 'orch@pc') as id`;
  await sql`update cb.tasks set stage = ${o.stage ?? null}, stage_since = now(), labels = ${o.labels ?? []}, assignee = ${o.assignee ?? null} where id = ${id}`;
  return Number(id);
}
const state = async (sup: any) => (await sup`select cb.supervise_state('sv') as r`)[0].r;

test('waiting counts per role', async () => {
  const { sql, sup } = await setup();
  await card(sql, { stage: 'build' }); await card(sql, { stage: 'review' }); await card(sql, { stage: 'qa' });
  await card(sql, { stage: null, type: 'research' });
  await card(sql, { stage: 'build', assignee: 'sv-B9@macbook' }); // held for a down session: not waiting
  await card(sql, { stage: null }); // unstaged
  const s = await state(sup);
  assert.equal(s.supervised, true);
  assert.deepEqual(s.waiting, { builder: { main: 1 }, reviewer: { main: 1 }, qa: 1, investigator: 1, architect: 0, owner: { claims: 0 } }); // no repos: one repo, main
});

test('owner first, architect after 15 minutes', async () => {
  const { sql, sup } = await setup();
  const id = await card(sql, { stage: 'design', labels: ['claims'] });
  let s = await state(sup);
  assert.equal(s.waiting.owner.claims, 1);
  assert.equal(s.waiting.architect, 0);
  await sql`update cb.tasks set stage_since = now() - interval '16 minutes' where id = ${id}`;
  s = await state(sup);
  assert.equal(s.waiting.architect, 1);
  assert.equal(s.waiting.owner.claims, 0); // never demand for both roles at once
  await card(sql, { stage: 'design', labels: ['other'] }); // no squad area tag: architect at once
  assert.equal((await state(sup)).waiting.architect, 2);
});

test('sessions carry busy facts', async () => {
  const { sql, sup } = await setup();
  await sql`update cb.sessions set last_seen = now() where actor = 'sv-B1@macbook'`;
  await sql`update cb.sessions set last_seen = now() - interval '5 minutes' where actor = 'sv-B2@macbook'`;
  const id = await card(sql, { stage: 'build', assignee: 'sv-B1@macbook' });
  await sql`update cb.tasks set status = 'in_progress' where id = ${id}`;
  await card(sql, { stage: 'build', assignee: 'sv-B9@macbook' }); // holder without a session row still listed
  await sql`insert into cb.questions (project, task_id, asked_by, body) values ('sv', ${id}, 'sv-B1@macbook', 'q?')`;
  await sql`insert into cb.runners (name) values ('r')`;
  await sql`insert into cb.jobs (project, recipe, sha, requester, state) values ('sv', 'test', 'abc1234', 'sv-B1@macbook', 'queued')`;
  await sql`insert into cb.events (actor, project, kind, summary) values ('sv-B2@macbook', 'sv', 'note', 'x')`;
  await sup`select cb.supervise_mark('sv-B2@macbook', true)`;
  const s = await state(sup);
  const by = Object.fromEntries(s.sessions.map((x: any) => [x.actor, x]));
  assert.deepEqual(Object.keys(by).sort(), ['sv-B1@macbook', 'sv-B2@macbook', 'sv-B9@macbook']);
  const b1 = by['sv-B1@macbook'], b2 = by['sv-B2@macbook'];
  assert.deepEqual([b1.role, b1.live, b1.holds, b1.questions, b1.jobs, b1.closing, b1.machine, b1.pane], ['builder', true, 1, 1, 1, false, 'macbook', 'p1']);
  assert.deepEqual([b1.repo, b2.repo], ['main', 'main']);
  assert.deepEqual([b2.live, b2.holds, b2.closing, b2.last_restore, b2.down_again_logged], [false, 0, true, null, false]);
  assert.ok(b2.last_event);
  assert.equal(new Date(b1.last_event).getTime(), new Date((await sql`select started_at from cb.sessions where actor = 'sv-B1@macbook'`)[0].started_at).getTime()); // no events: the session's start
  assert.equal(by['sv-B9@macbook'].holds, 1);
  assert.equal(by['sv-B9@macbook'].live, false);
});

// #4002: the supervisor reads each session's agent; a session row says claude unless bound as another
test('supervise_state sessions include agent (defaulting to claude)', async () => {
  const { sql, sup } = await setup();
  await sql`select cb.iam('macbook', 'p2', 'sv-B2@macbook', agent => 'codex')`;
  await card(sql, { stage: 'build', assignee: 'sv-B9@macbook' }); // a holder with no session row: no agent known
  const by = Object.fromEntries((await state(sup)).sessions.map((x: any) => [x.actor, x.agent]));
  assert.deepEqual(by, { 'sv-B1@macbook': 'claude', 'sv-B2@macbook': 'codex', 'sv-B9@macbook': null });
});

// #4332: the supervisor compares each seat's model with the squad's, and logs a restart in plain words
test('supervise_state sessions include the model each bound with; supervise_log takes a restart', async () => {
  const { sql, sup } = await setup();
  await sql`select cb.iam('macbook', 'p2', 'sv-B2@macbook', model => 'opus')`;
  const by = Object.fromEntries((await state(sup)).sessions.map((x: any) => [x.actor, x.model]));
  assert.deepEqual([by['sv-B1@macbook'], by['sv-B2@macbook']], [null, 'opus']);
  await sup`select cb.supervise_log('sv', 'restart', 'sv-B2@macbook', 'opus to sonnet')`;
  assert.equal((await sql`select summary from cb.events where data ->> 'what' = 'restart'`)[0].summary, 'restart sv-B2@macbook (opus to sonnet)');
});

test('a closing session cannot claim', async () => {
  const { sql, sup } = await setup();
  await card(sql, { stage: 'build' });
  assert.equal((await sup`select cb.supervise_mark('sv-B1@macbook', true) as r`)[0].r, true);
  const claim = async () => (await sql`select id from cb.task_claim('sv', 'sv-B1@macbook')`).length;
  const next = async () => (await sql`select cb.inbox('macbook', 'p1', 0) as r`)[0].r.next_work.length;
  assert.equal((await sql`select count(*)::int as n from cb.task_queue('sv', 'sv-B1@macbook')`)[0].n, 0);
  assert.equal(await claim(), 0);
  assert.equal(await next(), 0);
  await sql`update cb.sessions set closing_at = now() - interval '6 minutes' where actor = 'sv-B1@macbook'`;
  assert.equal(await next(), 1);
  assert.equal(await claim(), 1);
});

test('a marked actor that binds again (a restart under the same name) can claim', async () => {
  const { sql, sup } = await setup();
  await card(sql, { stage: 'build' });
  assert.equal((await sup`select cb.supervise_mark('sv-B1@macbook', true) as r`)[0].r, true);
  await sql`select cb.iam('macbook', 'p9', 'sv-B1@macbook', 'sv', 'builder')`; // the restarted session's new pane
  assert.equal((await sql`select count(*)::int as n from cb.sessions where actor = 'sv-B1@macbook' and closing_at is not null`)[0].n, 0);
  assert.equal((await sql`select id from cb.task_claim('sv', 'sv-B1@macbook')`).length, 1);
});

test('a mark loses to a held card', async () => {
  const { sql, sup } = await setup();
  const id = await card(sql, { stage: 'build', assignee: 'sv-B1@macbook' });
  await sql`update cb.tasks set status = 'in_progress' where id = ${id}`;
  assert.equal((await sup`select cb.supervise_mark('sv-B1@macbook', true) as r`)[0].r, false);
  assert.equal((await sql`select closing_at from cb.sessions where actor = 'sv-B1@macbook'`)[0].closing_at, null);
  assert.equal((await sup`select cb.supervise_mark('sv-B2@macbook', true) as r`)[0].r, true);
  assert.equal((await sup`select cb.supervise_mark('sv-B2@macbook', false) as r`)[0].r, false);
  assert.equal((await sql`select closing_at from cb.sessions where actor = 'sv-B2@macbook'`)[0].closing_at, null);
});

test('supervisor-only', async () => {
  const { sql } = await setup();
  await assert.rejects(sql`select cb.supervise_mark('sv-B1@macbook', true)`, /only the supervisor can do this/);
  await assert.rejects(sql`select cb.supervise_log('sv', 'start', 'sv-B3@macbook')`, /only the supervisor can do this/);
});

test('squad_set supervise', async () => {
  const { sql } = await setup({ ...SQUAD, supervise: false });
  assert.equal((await sql`select cb.squad_get('sv') as r`)[0].r.supervise, false);
  await sql`select cb.squad_set('sv', ${sql.json({ ...SQUAD, supervise: true })}, 'ahmed')`;
  assert.equal((await sql`select cb.squad_get('sv') as r`)[0].r.supervise, true);
  await assert.rejects(sql`select cb.squad_set('sv', ${sql.json({ ...SQUAD, supervise: 'yes' })}, 'ahmed')`, /supervise must be true or false/);
  await assert.rejects(sql`select cb.squad_set('sv', ${sql.json({ ...SQUAD, bogus: 1 })}, 'ahmed')`, /supervise/);
});

test('digest line', async () => {
  const { sql, sup } = await setup();
  await sup`select cb.supervise_log('sv', 'start', 'sv-B1@macbook')`;
  await sup`select cb.supervise_log('sv', 'start', 'sv-B2@macbook')`;
  await sup`select cb.supervise_log('sv', 'close', 'sv-B1@macbook')`;
  let d = (await sql`select cb.digest('sv', now() - interval '1 hour') as r`)[0].r;
  assert.ok(d.includes('supervisor: started 2, closed 1, restored 0 (cb sessions sv)'), JSON.stringify(d));
  await sup`select cb.supervise_log('sv', 'down_again', 'sv-B2@macbook', 'twice in 30 min')`;
  d = (await sql`select cb.digest('sv', now() - interval '1 hour') as r`)[0].r;
  assert.ok(d.includes('sv-B2@macbook down again: twice in 30 min'), JSON.stringify(d));
  const [e] = await sql`select actor, kind, summary, data from cb.events where kind = 'supervisor' order by id limit 1`;
  assert.deepEqual({ ...e, data: { ...e.data } }, { actor: 'supervisor', kind: 'supervisor', summary: 'start sv-B1@macbook', data: { what: 'start', session: 'sv-B1@macbook' } });
});

test('a runner event needs no project, and sessions_overview hides the supervisor', async () => {
  const { sql, sup } = await setup();
  await sup`select cb.supervise_log(null, 'runner', 'runner')`;
  await sup`select cb.supervise_log('sv', 'start', 'sv-B3@macbook')`;
  const rows = (await sql`select cb.sessions_overview('sv') as r`)[0].r;
  assert.ok(!rows.some((x: any) => x.actor === 'supervisor' || x.actor === 'runner'));
  const all = (await sql`select cb.sessions_overview() as r`)[0].r;
  assert.ok(!all.some((x: any) => x.actor === 'supervisor'));
});

test('supervise_mark is false for an actor with no session', async () => {
  const { sup } = await setup();
  assert.equal((await sup`select cb.supervise_mark('sv-B7@macbook', true) as r`)[0].r, false);
});

test('supervise_log refuses an empty session and a sensitive note, cuts long notes, keeps the note in data', async () => {
  const { sql, sup } = await setup();
  await assert.rejects(sup`select cb.supervise_log('sv', 'start', '')`, /session is required/);
  await assert.rejects(sup`select cb.supervise_log('sv', 'start', null)`, /session is required/);
  await assert.rejects(sup`select cb.supervise_log('sv', 'blocked', 'sv-B1@macbook', 'password: hunter2hunter2')`, /looks like|keeps no such text/);
  await sup`select cb.supervise_log('sv', 'blocked', 'sv-B1@macbook', ${'x'.repeat(300)})`;
  const [e] = await sql`select data from cb.events where kind = 'supervisor' order by id desc limit 1`;
  assert.equal(e.data.note.length, 200);
  assert.deepEqual(Object.keys(e.data).sort(), ['note', 'session', 'what']);
});

test('digest: blocked line, and the totals line survives six down_again events', async () => {
  const { sql, sup } = await setup();
  await sup`select cb.supervise_log('sv', 'blocked', 'sv-B1@macbook', 'startup dialog')`;
  let d = (await sql`select cb.digest('sv', now() - interval '1 hour') as r`)[0].r;
  assert.ok(d.includes('sv-B1@macbook blocked: startup dialog'), JSON.stringify(d));
  for (let i = 1; i <= 6; i++) await sup`select cb.supervise_log('sv', 'down_again', ${'sv-B' + i + '@macbook'}, 'twice')`;
  d = (await sql`select cb.digest('sv', now() - interval '1 hour') as r`)[0].r;
  const at = d.findIndex((l: string) => l.startsWith('supervisor: started 0, closed 0, restored 0'));
  assert.ok(at > 0, JSON.stringify(d));
  assert.ok(d[at + 1].includes('down again') || d[at + 1].includes('blocked'), JSON.stringify(d));
});

test('digest: a failed start gets its own line', async () => {
  const { sql, sup } = await setup();
  await sup`select cb.supervise_log('sv', 'failed', 'sv-B1@macbook', 'model missing')`;
  const d = (await sql`select cb.digest('sv', now() - interval '1 hour') as r`)[0].r;
  assert.ok(d.includes('sv-B1@macbook failed to start: model missing'), JSON.stringify(d));
});

test('down_again_logged after a restore then a down_again', async () => {
  const { sup } = await setup();
  await sup`select cb.supervise_log('sv', 'restore', 'sv-B1@macbook')`;
  let b1 = (await state(sup)).sessions.find((x: any) => x.actor === 'sv-B1@macbook');
  assert.deepEqual([!!b1.last_restore, b1.down_again_logged], [true, false]);
  await sup`select cb.supervise_log('sv', 'down_again', 'sv-B1@macbook')`;
  b1 = (await state(sup)).sessions.find((x: any) => x.actor === 'sv-B1@macbook');
  assert.equal(b1.down_again_logged, true);
});

test('last_event: a name reused by a fresh bind starts its idle clock at the bind, not at an old event', async () => {
  const { sql, sup } = await setup();
  await sql`insert into cb.events (actor, project, kind, summary, at) values ('sv-B1@macbook', 'sv', 'note', 'old', now() - interval '2 hours')`;
  await sql`update cb.sessions set started_at = now(), last_seen = now() where actor = 'sv-B1@macbook'`;
  const b1 = (await state(sup)).sessions.find((x: any) => x.actor === 'sv-B1@macbook');
  const [{ started_at }] = await sql`select started_at from cb.sessions where actor = 'sv-B1@macbook'`;
  assert.equal(new Date(b1.last_event).getTime(), new Date(started_at).getTime());
});

test('asks: open dashboard asks to the session are counted, done ones are not', async () => {
  const { sql, sup } = await setup();
  await sql`insert into cb.asks (project, to_actor, body) values ('sv', 'sv-B1@macbook', 'x'), ('sv', 'sv-B1@macbook', 'y')`;
  await sql`insert into cb.asks (project, to_actor, body, status) values ('sv', 'sv-B1@macbook', 'z', 'done')`;
  const by = Object.fromEntries((await state(sup)).sessions.map((x: any) => [x.actor, x]));
  assert.deepEqual([by['sv-B1@macbook'].asks, by['sv-B2@macbook'].asks], [2, 0]);
});

test('supervise_log refuses a session that is not a session name', async () => {
  const { sup } = await setup();
  for (const bad of ['sv B1', 'x'.repeat(65), "sv-B1@macbook'; --", 'sv/B1']) {
    await assert.rejects(sup`select cb.supervise_log('sv', 'start', ${bad})`, /session must be/);
  }
  await sup`select cb.supervise_log('sv', 'start', ${'sv-B1@mac.book_x'})`;
});

test('down_again_since_bind: set by a down_again, cleared when the name binds again', async () => {
  const { sql, sup } = await setup();
  const b1 = async () => (await state(sup)).sessions.find((x: any) => x.actor === 'sv-B1@macbook').down_again_since_bind;
  assert.equal(await b1(), false);
  await sup`select cb.supervise_log('sv', 'restore', 'sv-B1@macbook')`;
  await sup`select cb.supervise_log('sv', 'down_again', 'sv-B1@macbook')`;
  assert.equal(await b1(), true);
  await sql`select cb.iam('macbook', 'p1', 'sv-B1@macbook', 'sv', 'builder')`; // bound again by hand
  assert.equal(await b1(), false);
});

test('last_restore_failed: the latest restore did not start; a later restore that started clears it', async () => {
  const { sup } = await setup();
  const b1 = async () => (await state(sup)).sessions.find((x: any) => x.actor === 'sv-B1@macbook').last_restore_failed;
  assert.equal(await b1(), false);
  await sup`select cb.supervise_log('sv', 'restore', 'sv-B1@macbook', 'start failed')`;
  assert.equal(await b1(), true);
  await sup`select cb.supervise_log('sv', 'restore', 'sv-B1@macbook', 'builder')`; // a restore that started notes its role
  assert.equal(await b1(), false);
});

test('waiting and sessions per repo', async () => {
  const ZED = {
    machines: { macbook: { herdr: 'macbook', board: '/Users/me/Work/claude-board' } },
    repos: { api: { home: true, paths: { macbook: '/Users/me/Work/ZED/api' } }, dashboard: { paths: { macbook: '/Users/me/Work/ZED/dashboard' } } },
    areas: [{ name: 'api', repo: 'api' }, { name: 'dashboard', repo: 'dashboard' }],
    roles: { lead: { count: 1, machine: 'macbook' }, owner: { machine: 'macbook' },
             builder: { count: { api: 1, dashboard: 1 }, machine: 'macbook' }, reviewer: { count: { api: 1, dashboard: 1 }, machine: 'macbook' } },
    supervise: true,
  };
  const { sql, sup } = await setup(ZED);
  await sql`update cb.sessions set repo = 'api' where actor = 'sv-B1@macbook'`; // sv-B2 bound before repos: the home repo
  await sql`insert into cb.sessions (machine, pane, actor, project, role, repo) values ('macbook','p3','sv-dashboard-B1@macbook','sv','builder','dashboard')`;
  const repos = async (id: number, r: string[] | null) => sql`update cb.tasks set repos = ${r} where id = ${id}`;
  const part = (id: number, repo: string, stage: string, assignee: string | null = null) =>
    sql`insert into cb.task_parts (task_id, repo, stage, status, assignee) values (${id}, ${repo}, ${stage}, ${assignee ? 'in_progress' : 'next'}, ${assignee})`;
  // two parts at build, the api part held: only the dashboard part waits
  const two = await card(sql, { stage: 'build' });
  await repos(two, ['api', 'dashboard']);
  await part(two, 'api', 'build', 'sv-B1@macbook'); await part(two, 'dashboard', 'build');
  let s = await state(sup);
  assert.deepEqual(s.waiting.builder, { api: 0, dashboard: 1 });
  // a one-repo dashboard card adds one to dashboard
  await repos(await card(sql, { stage: 'build' }), ['dashboard']);
  // no repos in a project of several: nobody's, counted nowhere
  await card(sql, { stage: 'build' });
  // a part already at review while its card is at build: neither a builder's nor a reviewer's yet
  const ahead = await card(sql, { stage: 'build' });
  await repos(ahead, ['api', 'dashboard']);
  await part(ahead, 'api', 'review'); await part(ahead, 'dashboard', 'build', 'sv-dashboard-B1@macbook');
  // a one-repo api card in review
  await repos(await card(sql, { stage: 'review' }), ['api']);
  // a design card tagged dashboard: its owner's
  await card(sql, { stage: 'design', labels: ['dashboard'] });
  s = await state(sup);
  assert.deepEqual(s.waiting.builder, { api: 0, dashboard: 2 });
  assert.deepEqual(s.waiting.reviewer, { api: 1, dashboard: 0 });
  assert.deepEqual(s.waiting.owner, { api: 0, dashboard: 1 });
  assert.equal(s.waiting.architect, 0);
  const by = Object.fromEntries(s.sessions.map((x: any) => [x.actor, x.repo]));
  assert.deepEqual(by, { 'sv-B1@macbook': 'api', 'sv-B2@macbook': 'api', 'sv-dashboard-B1@macbook': 'dashboard' });
});

test('a squad with one repo: a card with no repos named counts under it', async () => {
  const ONE = {
    machines: { macbook: { herdr: 'macbook', board: '/Users/me/Work/claude-board' } },
    repos: { api: { paths: { macbook: '/Users/me/Work/ZED/api' } } },
    roles: { builder: { count: { api: 2 }, machine: 'macbook' }, reviewer: { count: { api: 1 }, machine: 'macbook' } },
    supervise: true,
  };
  const { sql, sup } = await setup(ONE);
  await card(sql, { stage: 'build' }); await card(sql, { stage: 'review' });
  const s = await state(sup);
  assert.deepEqual([s.waiting.builder, s.waiting.reviewer], [{ api: 1 }, { api: 1 }]);
  assert.ok(s.sessions.every((x: any) => x.repo === 'api'));
});

test("#4787: quota_told stands from a quota log until the seat's next board event or a new bind", async () => {
  const { sql, sup } = await setup();
  const b1 = async () => (await state(sup)).sessions.find((x: any) => x.actor === 'sv-B1@macbook').quota_told;
  assert.equal(await b1(), false);
  await sup`select cb.supervise_log('sv', 'quota', 'sv-B1@macbook', 'herdr pane w1:p9')`;
  assert.equal(await b1(), true);
  await sql`insert into cb.events (actor, project, kind, summary) values ('sv-B2@macbook', 'sv', 'note', 'another seat')`;
  assert.equal(await b1(), true);
  await sql`insert into cb.events (actor, project, kind, summary) values ('sv-B1@macbook', 'sv', 'note', 'working again')`;
  assert.equal(await b1(), false);
  await sup`select cb.supervise_log('sv', 'quota', 'sv-B1@macbook')`;
  assert.equal(await b1(), true);
  await sql`update cb.sessions set started_at = clock_timestamp() where actor = 'sv-B1@macbook'`; // a restart: a new session
  assert.equal(await b1(), false);
});

test('#4787: a quota stop has its own digest line', async () => {
  const { sql, sup } = await setup();
  await sup`select cb.supervise_log('sv', 'quota', 'sv-B1@macbook', 'herdr pane w1:p9')`;
  const d = (await sql`select cb.digest('sv', now() - interval '1 hour') as r`)[0].r;
  assert.ok(d.includes('sv-B1@macbook stopped by its quota: herdr pane w1:p9'), JSON.stringify(d));
});

test('#4559 slice 3: a supervised project that is not live winds down; running jobs are counted apart', async () => {
  const { sql, sup } = await setup();
  assert.equal((await state(sup)).winding_down, false);
  await sql`select cb.project_state('sv', 'disabled', 'ahmed')`;
  const s = await state(sup);
  assert.deepEqual([s.supervised, s.winding_down, !!s.state_at], [false, true, true]);
  assert.deepEqual(s.sessions.map((x: any) => x.jobs_running), s.sessions.map(() => 0));
  await sql`select cb.project_state('sv', 'archived', 'ahmed')`;
  assert.equal((await state(sup)).winding_down, true);
  await sql`select cb.project_state('sv', 'disabled', 'ahmed')`;
  await sql`select cb.squad_set('sv', ${sql.json({ ...SQUAD, supervise: false })}, 'ahmed')`;
  assert.equal((await state(sup)).winding_down, false, 'a squad the supervisor does not run is left alone');
});

test('#4806: a project with no stages is supervised when its squad says so, with nothing counted as waiting', async () => {
  const { sql, sup } = await setup();
  await card(sql, { stage: 'build' }); await card(sql, { stage: null }); await card(sql, { stage: null, type: 'research' });
  await sql`select cb.project_pipeline('sv', false, 'ahmed')`;
  let s = await state(sup);
  // said under its own key: a supervisor started before this change plans from 'supervised', and with nothing counted as
  // waiting it would close every idle seat here between the schema's upgrade and its own restart
  assert.deepEqual([s.supervised, s.supervised_unstaged, s.winding_down, s.pipeline], [false, true, false, false]);
  // waiting by stage is the pipeline's: no stages, no seat is started for a card
  assert.deepEqual(s.waiting, { builder: { main: 0 }, reviewer: { main: 0 }, qa: 0, investigator: 0, architect: 0, owner: { claims: 0 } });
  await sql`select cb.project_state('sv', 'disabled', 'ahmed')`;
  s = await state(sup);
  assert.deepEqual([s.supervised, s.supervised_unstaged, s.winding_down], [false, false, true]);
  await sql`select cb.project_state('sv', 'enabled', 'ahmed')`;
  await sql`select cb.squad_set('sv', ${sql.json({ ...SQUAD, supervise: false })}, 'ahmed')`;
  s = await state(sup);
  assert.deepEqual([s.supervised, s.supervised_unstaged, s.winding_down], [false, false, false]);
});

test('#4806: the board names the projects the supervisor will act on', async () => {
  const { sql, sup } = await setup();
  for (const [slug, supervise] of [['plain', true], ['off', false], ['gone', true]] as const) {
    await sql`select cb.ensure_project(${slug})`;
    await sql`select cb.squad_set(${slug}, ${sql.json({ ...SQUAD, supervise })}, 'ahmed')`;
  }
  await sql`select cb.project_state('gone', 'disabled', 'ahmed')`;
  assert.deepEqual((await sql`select cb.squad_page('off') as r`)[0].r.acts_on,
    [{ project: 'gone', winding_down: true }, { project: 'plain', winding_down: false }, { project: 'sv', winding_down: false }]);
});
