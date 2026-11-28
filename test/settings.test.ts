// The project settings page's backend (#4332): squad versions, the page's reads, role texts the database owns, the
// GitHub watch functions and the owner-only rule on the server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts'; // sets CB_DATABASE_URL before the server's db client loads
import { INSTALLED } from '../cli/agents/index.ts';

const { app } = await import('../server/main.ts');
const { sql: serverSql } = await import('../server/db.ts');

const clients: any[] = [];
after(() => Promise.all([...clients.map((c) => c.end()), serverSql.end()]));
async function db() { const s = await freshDb(); clients.push(s); return s; }
/** A session's connection: not the dashboard (cb.dashboard_only refuses it). */
function session() { const s = postgres(TEST_URL, { onnotice: () => {} }); clients.push(s); return s; }

function cb(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('node', ['cli/cb.ts', ...args], {
    encoding: 'utf8', env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'orch@pc', HERDR_PANE_ID: '', PGAPPNAME: '', ...env },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const SQUAD = {
  machines: { macbook: { herdr: 'macbook', repo: '/Users/me/Work/x', board: '/Users/me/Work/claude-board' }, shaltoot: { herdr: null, repo: 'C:/work/x', board: 'C:/work/claude-board' } },
  roles: { lead: { count: 1, model: 'opus', machine: 'shaltoot' }, builder: { count: 3, model: 'sonnet', machine: 'macbook' }, reviewer: { count: 1, model: 'opus', machine: 'macbook' } },
  areas: [],
};
const MORE = { ...SQUAD, roles: { ...SQUAD.roles, builder: { count: 4, model: 'sonnet', machine: 'macbook' } } };
const events = async (sql: any) => (await sql`select data from cb.events where summary = 'squad updated' order by id`).map((e: any) => e.data);
const version = async (sql: any) => (await sql`select squad_version as v from cb.projects where slug = 'demo'`)[0].v;

test('the save gate and the launch gate name the same main agents: cb._agents_main() = INSTALLED, all four (#4585, Q3024)', async () => {
  const sql = await db();
  const [{ a }] = await sql`select cb._agents_main() as a`;
  assert.deepEqual([...a].sort(), [...INSTALLED].sort());
  assert.deepEqual([...a].sort(), ['agy', 'claude', 'codex', 'opencode']);
  // any project saves a role and seats of each agent
  const four = { ...SQUAD, roles: { ...SQUAD.roles, builder: { count: 4, machine: 'macbook', model: 'sonnet', seats: {
    '2': { agent: 'codex', model: 'gpt-6.1-sol' }, '3': { agent: 'agy', model: 'gemini-4-neon-xhigh' }, '4': { agent: 'opencode', model: 'anthropic/claude-opus-5-5' } } },
    reviewer: { count: 1, machine: 'macbook', agent: 'codex', model: 'gpt-6.1-sol' } } };
  await sql`select cb.ensure_project('demo')`;
  const [{ s }] = await sql`select cb.squad_set('demo', ${sql.json(four)}, 'ahmed') as s`;
  assert.deepEqual(Object.values(s.roles.builder.seats).map((x: any) => x.agent), ['codex', 'agy', 'opencode']);
  assert.equal(s.roles.reviewer.agent, 'codex');
  // the page offers each as a main agent
  const [{ o }] = await sql`select cb.squad_options() as o`;
  assert.deepEqual(o.agents.filter((x: any) => x.main).map((x: any) => x.agent), ['claude', 'codex', 'opencode', 'agy']);
});

test('squad_set: each real change raises the version once, a no-op writes nothing, a stale base is refused in plain words', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  assert.equal(await version(sql), 0);
  assert.equal((await sql`select cb.squad_get('demo', with_version => true) as s`)[0].s, null, 'no squad: null, version or not');
  await sql`select cb.squad_set('demo', ${sql.json(SQUAD)}, 'ahmed', base => 0)`;
  assert.equal(await version(sql), 1);
  assert.deepEqual((await sql`select cb.squad_get('demo', with_version => true) as s`)[0].s, { ...SQUAD, version: 1 });
  assert.deepEqual((await sql`select cb.squad_get('demo') as s`)[0].s, SQUAD, 'squad_get without with_version is unchanged');

  // the same squad again: no event (the supervisor's 20-snapshot window), the same version, the squad returned
  assert.deepEqual((await sql`select cb.squad_set('demo', ${sql.json(SQUAD)}, 'ahmed', base => 1) as s`)[0].s, SQUAD);
  await sql`select cb.squad_set('demo', ${sql.json(SQUAD)}, 'ahmed')`;
  assert.equal(await version(sql), 1);
  assert.equal((await events(sql)).length, 1);

  assert.deepEqual((await sql`select cb.squad_set('demo', ${sql.json(MORE)}, 'ahmed', base => 1, with_version => true) as s`)[0].s,
    { ...MORE, version: 2, changed: true });
  assert.deepEqual((await sql`select cb.squad_set('demo', ${sql.json(MORE)}, 'ahmed', base => 2, with_version => true) as s`)[0].s,
    { ...MORE, version: 2, changed: false });
  assert.equal(await version(sql), 2);
  // a copy taken at version 1 can't undo the change made since
  await assert.rejects(sql`select cb.squad_set('demo', ${sql.json(SQUAD)}, 'ahmed', base => 1)`,
    /Someone changed this squad since your copy was taken \(it is now version 2, your copy is version 1\)\. Load it again \(reopen the page, or cb squad show demo --json\), make your change there and save\./);
  await assert.rejects(sql`select cb.squad_set('demo', ${sql.json(SQUAD)}, 'ahmed', base => 7)`, /it is now version 2, your copy is version 7/);
  assert.equal(await version(sql), 2);
  assert.equal((await events(sql)).length, 2);

  // a caller without base (a CLI from before #4332) still saves; a session's save says cli
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('pc', 'p1', 'orch@pc', 'demo', 'lead')`;
  await session()`select cb.squad_set('demo', ${sql.json(SQUAD)}, 'orch@pc')`;
  const ev = await events(sql);
  assert.deepEqual(ev.map((e: any) => [e.version, e.via]), [[1, 'page'], [2, 'page'], [3, 'cli']]);
  assert.deepEqual(ev[2].squad, SQUAD);
});

test('a full squad (repos, areas, seats, fallback, protected, workspace) read back and saved unchanged keeps its version', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('zed')`;
  const full = {
    machines: { shaltoot: { herdr: null, board: 'C:/work/claude-board' }, macbook: { herdr: 'macbook', board: '/Users/me/Work/claude-board', workspace: 'Zed Squad' } },
    repos: { api: { home: true, paths: { shaltoot: 'C:/work/zed/api', macbook: '/Users/me/Work/zed/api' } },
             dashboard: { paths: { shaltoot: 'C:/work/zed/dashboard', macbook: '/Users/me/Work/zed/dashboard' } } },
    areas: [{ name: 'api', repo: 'api' }, { name: 'dashboard', repo: 'dashboard' }],
    roles: { lead: { count: 1, machine: 'shaltoot' }, owner: { machine: 'shaltoot' },
             builder: { count: { api: 2, dashboard: 1 }, machine: 'macbook', fallback: [{ agent: 'codex', model: 'gpt-6.1-sol' }], seats: { 'api:2': { model: 'opus' } } },
             reviewer: { count: { api: 1, dashboard: 1 }, machine: 'macbook' } },
    supervise: true, protected: ['main', 'releases/*'],
  };
  await sql`select cb.squad_set('zed', ${sql.json(full)}, 'ahmed')`;
  const read = (await sql`select cb.squad_get('zed', with_version => true) as s`)[0].s;
  const { version: v, ...back } = read;
  assert.equal(v, 1);
  await sql`select cb.squad_set('zed', ${sql.json(back)}, 'ahmed', base => ${v})`;
  assert.equal((await sql`select squad_version as v from cb.projects where slug = 'zed'`)[0].v, 1);
  assert.equal((await sql`select count(*)::int as n from cb.events where summary = 'squad updated'`)[0].n, 1);
});

test('cb squad show --json carries the version and cb squad set takes it back as the base', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('pc', 'p1', 'orch@pc', 'demo', 'lead')`;
  const dir = mkdtempSync(join(tmpdir(), 'squad-v-'));
  const file = (name: string, s: unknown) => { const f = join(dir, name); writeFileSync(f, JSON.stringify(s)); return f; };
  try {
    // no version yet (a new squad, or one saved before #4332): a file without one is fine
    const first = cb(['squad', 'set', 'demo', '-f', file('a.json', SQUAD)]);
    assert.equal(first.code, 0, first.err);
    assert.equal(first.out, 'squad saved for demo (version 1)');
    const shown = JSON.parse(cb(['squad', 'show', 'demo', '--json']).out);
    assert.equal(shown.version, 1);
    assert.match(cb(['squad', 'show', 'demo']).out, /^lead {2}1 × opus on shaltoot$/m, 'the text view prints no version line');

    // the shown copy back unchanged: nothing written
    const same = cb(['squad', 'set', 'demo', '-f', file('b.json', shown)]);
    assert.equal(same.code, 0, same.err);
    assert.equal(same.out, 'nothing changed for demo: the squad is already this (version 1)');
    assert.equal((await events(sql)).length, 1);

    // edited: saved as version 2
    const edited = cb(['squad', 'set', 'demo', '-f', file('c.json', { ...shown, roles: MORE.roles })]);
    assert.equal(edited.code, 0, edited.err);
    assert.equal(edited.out, 'squad saved for demo (version 2)');

    // the old copy (version 1) is refused: it would undo version 2
    const stale = cb(['squad', 'set', 'demo', '-f', file('b.json', shown)]);
    assert.equal(stale.code, 1);
    assert.match(stale.err, /Someone changed this squad since your copy was taken \(it is now version 2, your copy is version 1\)/);

    // no version once the squad has one: refused, unless --overwrite
    const bare = cb(['squad', 'set', 'demo', '-f', file('a.json', SQUAD)]);
    assert.equal(bare.code, 1);
    assert.match(bare.err, /demo's squad was saved as version 2, and this file has no version, so it could undo a newer change\. Take the current squad with cb squad show demo --json, edit that and set it again\. \(--overwrite replaces the current squad with this file, including any change made on the settings page\.\)/);
    assert.equal(await version(sql), 2);
    const forced = cb(['squad', 'set', 'demo', '-f', file('a.json', SQUAD), '--overwrite', '--json']);
    assert.equal(forced.code, 0, forced.err);
    // the reply comes from squad_set's own locked read: version and changed
    assert.deepEqual(JSON.parse(forced.out), { ...SQUAD, version: 3, changed: true });
    assert.equal(cb(['squad', 'set', 'demo', '-f', file('a.json', SQUAD), '--overwrite']).out, 'nothing changed for demo: the squad is already this (version 3)');
    assert.match(cb(['squad', 'set', 'demo', '-f', file('d.json', { ...SQUAD, version: 'x' })]).err, /"version" in the squad file must be the number cb squad show demo --json printed/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('squad_options: the agents (main or backup only), the limits and the names already used', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  await sql`select cb.squad_set('demo', ${sql.json({ ...SQUAD, roles: { ...SQUAD.roles,
    builder: { count: 2, machine: 'macbook', fallback: [{ agent: 'codex', model: 'gpt-6.1-sol' }], seats: { '2': { model: 'opus' } } } } })}, 'ahmed')`;
  const [{ o }] = await sql`select cb.squad_options() as o`;
  assert.deepEqual(o.agents, [{ agent: 'claude', main: true }, { agent: 'codex', main: true }, { agent: 'opencode', main: true }, { agent: 'agy', main: true }]);
  assert.deepEqual(o.claude_models, ['opus', 'sonnet', 'haiku', 'fable']);
  assert.deepEqual(o.roles, ['lead', 'architect', 'owner', 'builder', 'reviewer', 'qa', 'investigator']);
  assert.equal(o.default_models.builder, 'sonnet');
  assert.equal(o.default_models.lead, 'opus');
  assert.deepEqual(o.limits, { count_min: 1, count_max: 8, lead_count: 1, macbook_seats: 8, fallbacks: 5, session_name: 32, protected: 30, protected_length: 100, workspace_length: 64 });
  assert.deepEqual(o.models_used, { claude: ['opus', 'sonnet'], codex: ['gpt-6.1-sol'] });
  assert.deepEqual(o.machines_used.map((m: any) => m.key).sort(), ['macbook', 'shaltoot']);
  assert.ok(new RegExp(o.patterns.slug).test('macbook') && !new RegExp(o.patterns.slug).test('Mac_Book'));
});

test('a model that is two known names joined is refused on save, so a CLI save cannot store one (#4717)', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  // two agy names used in one squad, so both are known for agy
  await sql`select cb.squad_set('demo', ${sql.json({ ...SQUAD, roles: { ...SQUAD.roles,
    builder: { count: 2, machine: 'macbook', agent: 'agy', model: 'gemini-4-neon-high', seats: { '2': { model: 'gemini-4-neon-xhigh' } } } } })}, 'ahmed')`;
  const [{ o }] = await sql`select cb.squad_options() as o`;
  assert.deepEqual(o.models_used.agy, ['gemini-4-neon-high', 'gemini-4-neon-xhigh']);
  // the picker slip, saved from the CLI: refused, naming both halves
  await sql`select cb.ensure_project('other')`;
  const joined = 'gemini-4-neon-highgemini-4-neon-xhigh';
  await assert.rejects(sql`select cb.squad_set('other', ${sql.json({ ...SQUAD, roles: { ...SQUAD.roles,
    builder: { count: 1, machine: 'macbook', agent: 'agy', model: joined } } })}, 'ahmed')`, /two model names joined/);
  // and the same name twice, which the page refuses too
  await assert.rejects(sql`select cb.squad_set('other', ${sql.json({ ...SQUAD, roles: { ...SQUAD.roles,
    builder: { count: 1, machine: 'macbook', agent: 'agy', model: 'gemini-4-neon-highgemini-4-neon-high' } } })}, 'ahmed')`, /two model names joined/);
  // a single known name still saves
  await sql`select cb.squad_set('other', ${sql.json({ ...SQUAD, roles: { ...SQUAD.roles,
    builder: { count: 1, machine: 'macbook', agent: 'agy', model: 'gemini-4-neon-xhigh' } } })}, 'ahmed')`;
});

test('squad_page: the squad and its version, live seats against what they should run, history newest first, reminders', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  await sql`select cb.squad_set('demo', ${sql.json(SQUAD)}, 'ahmed')`;
  await sql`select cb.squad_set('demo', ${sql.json({ ...SQUAD, supervise: true, roles: { ...SQUAD.roles, builder: { count: 3, model: 'sonnet', machine: 'macbook', seats: { '2': { model: 'opus' } } } } })}, 'ahmed')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role, model, agent, last_seen) values
    ('pc', 'p1', 'orch@shaltoot', 'demo', 'lead', 'opus', 'claude', now()),
    ('mac', 'p2', 'demo-B1@macbook', 'demo', 'builder', 'sonnet', 'claude', now()),
    ('mac', 'p3', 'demo-B2@macbook', 'demo', 'builder', 'sonnet', 'claude', now()),
    ('mac', 'p4', 'demo-B3@macbook', 'demo', 'builder', 'sonnet', 'claude', now() - interval '5 minutes')`;
  const t1 = Number((await sql`select cb.task_add(project => 'demo', title => 'one', actor => 'W1@pc') as id`)[0].id);
  await sql`select cb.task_add(project => 'demo', title => 'two', actor => 'W1@pc')`;
  await sql`select cb.task_ping_set(${String(t1)}, true, 'ahmed')`;
  const [{ p }] = await sql`select cb.squad_page('demo') as p`;
  assert.equal(p.project, 'demo');
  assert.equal(p.version, 2);
  assert.equal(p.squad.roles.builder.seats['2'].model, 'opus');
  assert.equal(p.pipeline, false);
  assert.equal(p.supervise, true);
  // B3 was last seen 5 minutes ago: not running now
  assert.deepEqual(p.seats.map((s: any) => [s.actor, s.agent, s.model, s.want_agent, s.want_model, s.same, s.in_squad]), [
    ['demo-B1@macbook', 'claude', 'sonnet', 'claude', 'sonnet', true, true],
    ['demo-B2@macbook', 'claude', 'sonnet', 'claude', 'opus', false, true],
    ['orch@shaltoot', 'claude', 'opus', 'claude', 'opus', true, true],
  ]);
  assert.deepEqual(p.history.map((h: any) => [h.version, h.via, h.actor]), [[2, 'page', 'ahmed'], [1, 'page', 'ahmed']]);
  assert.equal(p.history[1].squad.roles.builder.seats, undefined);
  assert.deepEqual(p.reminders, { open: 2, on: 1 });
  await assert.rejects(sql`select cb.squad_page('nope')`, /unknown project/);
  // a project with no squad yet: an empty page, not an error
  await sql`select cb.ensure_project('bare')`;
  const [{ b }] = await sql`select cb.squad_page('bare') as b`;
  assert.deepEqual([b.squad, b.version, b.seats, b.history], [null, 0, [], []]);
});

test('role_text_set: Ahmed only, plain refusals, a cap, history with before and after; role_text_page reads it raw', async () => {
  const sql = await db();
  const before = (await sql`select body from cb.role_texts where role = 'builder'`)[0].body;
  await assert.rejects(session()`select cb.role_text_set('builder', 'x', 'W1@pc')`, /only Ahmed can do this, on the Project settings page of the dashboard/);
  await assert.rejects(sql`select cb.role_text_set('wizard', 'x', 'ahmed')`, /unknown role wizard: one of lead, .* or _common for the rules every role follows/);
  await assert.rejects(sql`select cb.role_text_set('builder', ${'  \n '}, 'ahmed')`, /the text for builder is empty: write what this role does/);
  await assert.rejects(sql`select cb.role_text_set('builder', ${'x'.repeat(8001)}, 'ahmed')`, /the text for builder is 8001 characters; the most is 8000/);
  assert.equal((await sql`select count(*)::int as n from cb.role_text_edits`)[0].n, 0);

  const r = (await sql`select cb.role_text_set('builder', ${'\nBuild the card.\n'}, 'ahmed') as r`)[0].r;
  assert.deepEqual([r.role, r.body, r.updated_by, r.changed], ['builder', 'Build the card.', 'ahmed', true]);
  const common = (await sql`select body from cb.role_texts where role = '_common'`)[0].body;
  assert.equal((await sql`select cb.role_text('builder') as t`)[0].t, common + '\n\nBuild the card.', 'cb role reads the new text');
  // the same text again writes nothing
  assert.equal((await sql`select cb.role_text_set('builder', 'Build the card.', 'ahmed') as r`)[0].r.changed, false);
  await sql`select cb.role_text_set('_common', 'Rules for all.', 'ahmed')`;
  await sql`select cb.role_text_set('builder', ${'y'.repeat(8000)}, 'ahmed')`; // the cap itself passes

  const edits = await sql`select role, before, after, actor from cb.role_text_edits order by id`;
  assert.deepEqual(edits.map((e: any) => [e.role, e.before === before, e.after.slice(0, 15), e.actor]),
    [['builder', true, 'Build the card.', 'ahmed'], ['_common', false, 'Rules for all.', 'ahmed'], ['builder', false, 'yyyyyyyyyyyyyyy', 'ahmed']]);
  const ev = await sql`select actor, project, data from cb.events where summary = 'role text updated' order by id`;
  assert.equal(ev.length, 3);
  // the event names the edit row and the sizes; the texts themselves stay in role_text_edits, not in cb.events
  const ids = (await sql`select id from cb.role_text_edits order by id`).map((e: any) => Number(e.id));
  assert.deepEqual([ev[0].actor, ev[0].project, ev[0].data], ['ahmed', null,
    { role: 'builder', edit_id: ids[0], before_length: before.length, after_length: 'Build the card.'.length }]);
  assert.deepEqual(ev.map((e: any) => e.data.edit_id), ids);

  const [{ pg }] = await sql`select cb.role_text_page() as pg`;
  assert.deepEqual(pg.roles.map((x: any) => x.role), ['_common', 'lead', 'architect', 'owner', 'builder', 'reviewer', 'qa', 'investigator']);
  const b = pg.roles.find((x: any) => x.role === 'builder');
  assert.deepEqual([b.body.length, b.updated_by], [8000, 'ahmed']);
  assert.equal(pg.roles.find((x: any) => x.role === 'qa').updated_by, null, 'seeded from the files: no one');
  assert.deepEqual(pg.edits.map((e: any) => e.role), ['builder', '_common', 'builder'], 'newest first');
});

// #4525 (Q2992, Q2994): one project's own rules and who its stuck seats ask first, after the board-wide text
test('project_role_set: Ahmed only, a 1000 cap, lead/ahmed/a session; cb.role_text adds the addition and the ask-first line last', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  const board = (await sql`select cb.role_text('builder') as t`)[0].t;
  // no row: no addition, and the lead first (how squads ran before the setting); the lead is told seats ask it
  assert.equal((await sql`select cb.role_text('builder', 'demo') as t`)[0].t,
    `${board}\n\n# This project: demo\n\nAsk first when stuck or a decision is needed: the lead (\`cb tell <name>\`; \`cb sessions\` names it). The lead decides from Ahmed's rulings or asks him on the board.`);
  assert.match((await sql`select cb.role_text('lead', 'demo') as t`)[0].t, /\nAsk first when stuck or a decision is needed: seats in this project ask you\. /);
  assert.equal((await sql`select cb.role_text('builder', null) as t`)[0].t, board, 'no project: the board-wide text alone');
  await assert.rejects(sql`select cb.role_text('builder', 'nowhere')`, /unknown project "nowhere"/);

  await assert.rejects(session()`select cb.project_role_set('demo', 'x', null, 'W1@pc')`, /only Ahmed can do this, on the Project settings page of the dashboard/);
  await assert.rejects(sql`select cb.project_role_set('demo', ${'x'.repeat(1001)}, null, 'ahmed')`, /the addition for demo is 1001 characters; the most is 1000/);
  await assert.rejects(sql`select cb.project_role_set('demo', null, 'two words', 'ahmed')`, /ask first must be lead, ahmed or a session name/);
  await assert.rejects(sql`select cb.project_role_set('nowhere', 'x', null, 'ahmed')`, /unknown project "nowhere"/);
  assert.equal((await sql`select count(*)::int as n from cb.project_role_settings`)[0].n, 0);

  const r = (await sql`select cb.project_role_set('demo', ${'\nNo internal codes on any screen.\n'}, 'KB1@pc', 'ahmed') as r`)[0].r;
  assert.deepEqual([r.addition, r.ask_first, r.updated_by, r.changed], ['No internal codes on any screen.', 'KB1@pc', 'ahmed', true]);
  assert.equal((await sql`select cb.role_text('qa', 'demo') as t`)[0].t.slice((await sql`select cb.role_text('qa') as t`)[0].t.length),
    '\n\n# This project: demo\n\nNo internal codes on any screen.\n\nAsk first when stuck or a decision is needed: KB1@pc (`cb tell KB1@pc`). It decides or asks Ahmed on the board.');
  // review M2: the named session itself is told seats ask it, never to ask itself (any case); everyone else is told to ask it
  for (const me of ['KB1@pc', 'kb1@PC'])
    assert.match((await sql`select cb.role_text('qa', 'demo', ${me}) as t`)[0].t, /\nAsk first when stuck or a decision is needed: seats in this project ask you\. /, me);
  assert.match((await sql`select cb.role_text('qa', 'demo', 'Q2@pc') as t`)[0].t, /: KB1@pc \(`cb tell KB1@pc`\)\. It decides or asks Ahmed on the board\.$/);
  // null keeps a part; the same values write nothing; Ahmed, any case
  assert.equal((await sql`select cb.project_role_set('demo', null, null, 'ahmed') as r`)[0].r.changed, false);
  const a = (await sql`select cb.project_role_set('demo', null, 'Ahmed', 'ahmed') as r`)[0].r;
  assert.deepEqual([a.addition, a.ask_first], ['No internal codes on any screen.', 'ahmed']);
  assert.match((await sql`select cb.role_text('builder', 'demo') as t`)[0].t, /\n\nAsk first when stuck or a decision is needed: Ahmed, on the board \(`cb ask`\)\.$/);
  // an empty addition removes it; the cap itself passes
  await sql`select cb.project_role_set('demo', ${'y'.repeat(1000)}, null, 'ahmed')`;
  await sql`select cb.project_role_set('demo', '', 'lead', 'ahmed')`;
  assert.equal((await sql`select cb.role_text('builder', 'demo') as t`)[0].t.includes('\n\n\n'), false);
  const ev = await sql`select actor, project, data from cb.events where summary = 'project role text updated' order by id`;
  assert.deepEqual(ev.map((e: any) => [e.actor, e.project, e.data.ask_first_before, e.data.ask_first, e.data.addition.length]),
    [['ahmed', 'demo', 'lead', 'KB1@pc', 32], ['ahmed', 'demo', 'KB1@pc', 'ahmed', 32], ['ahmed', 'demo', 'ahmed', 'ahmed', 1000], ['ahmed', 'demo', 'ahmed', 'lead', 0]]);

  await sql`select cb.iam('pc', 'p-prs', 'B4@pc', 'demo', 'builder')`;
  const [{ pg }] = await sql`select cb.project_role_page('demo') as pg`;
  assert.deepEqual([pg.project, pg.addition, pg.ask_first, pg.updated_by, pg.cap, pg.sessions], ['demo', '', 'lead', 'ahmed', 1000, ['B4@pc']]);
});

test('role_text_import: Ahmed only, every text or none, each change kept with its text before', async () => {
  const sql = await db();
  const old = (await sql`select role, body from cb.role_texts order by role`).map((r: any) => [r.role, r.body]);
  await assert.rejects(session()`select cb.role_text_import(${sql.json({ builder: "x" })}::jsonb, 'W1@pc')`, /only Ahmed can do this/);
  await assert.rejects(sql`select cb.role_text_import('{}'::jsonb, 'ahmed')`, /no texts to load/);
  // a bad text anywhere loads nothing, not even the good ones before it
  await assert.rejects(sql`select cb.role_text_import(${sql.json({ _common: "New rules.", builder: "New builder.", wizard: "x" })}::jsonb, 'ahmed')`, /unknown role wizard/);
  assert.deepEqual((await sql`select role, body from cb.role_texts order by role`).map((r: any) => [r.role, r.body]), old);
  const qa = old.find(([r]: any) => r === 'qa')[1];
  const r = (await sql`select cb.role_text_import(${sql.json({ builder: "New builder.", _common: "New rules.", qa })}::jsonb, 'ahmed') as r`)[0].r;
  assert.deepEqual(r, { changed: ['_common', 'builder'], unchanged: 1 });
  assert.equal((await sql`select cb.role_text('builder') as t`)[0].t, 'New rules.\n\nNew builder.');
  assert.deepEqual((await sql`select role, actor, via from cb.role_text_edits order by id`).map((e: any) => [e.role, e.actor, e.via]),
    [['_common', 'ahmed', 'import'], ['builder', 'ahmed', 'import']]);
  // review M1: a load sets updated_by too, yet only a change made by hand afterwards counts as edited on the page
  const edited = async () => Object.fromEntries((await sql`select cb.role_text_page() as pg`)[0].pg.roles.map((x: any) => [x.role, x.edited]));
  let e = await edited();
  assert.deepEqual([e._common, e.builder, e.qa], [false, false, false], 'loaded, loaded, seeded');
  await sql`select cb.role_text_set('builder', 'Hand edit.', 'ahmed')`;
  e = await edited();
  assert.deepEqual([e._common, e.builder], [false, true]);
  await sql`select cb.role_text_import(${sql.json({ builder: 'Loaded again.' })}::jsonb, 'ahmed')`;
  assert.equal((await edited()).builder, false, 'a later load clears it');
});

test('github_watches: one project\'s watches (its own and those that log on its cards) and the muted logins', async () => {
  const sql = await db();
  for (const p of ['demo', 'iris', 'other']) await sql`select cb.ensure_project(${p})`;
  await sql`select cb.github_watch_add('acme/one', project => 'demo', tell => 'orch@pc', actor => 'ahmed')`;
  await sql`select cb.github_watch_add('acme/two', project => 'iris', tell => 'orch@pc', cards_in => ${sql.json(['demo'])}, actor => 'ahmed')`;
  await sql`select cb.github_watch_add('acme/three', project => 'other', tell => 'orch@pc', actor => 'ahmed')`;
  await sql`insert into cb.settings (key, value) values ('github:outbox:x', '{}')`;
  await sql`select cb.github_mute('Bot-User', actor => 'ahmed')`;
  const [{ w }] = await sql`select cb.github_watches('demo') as w`;
  assert.deepEqual(w.watches.map((x: any) => [x.repo, x.project, x.card_projects ?? null]), [['acme/one', 'demo', null], ['acme/two', 'iris', ['demo']]]);
  assert.match(w.watches[0].since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, 'since keeps the ISO shape the poller and cb github print');
  assert.deepEqual(w.muted, ['bot-user']);
  assert.equal((await sql`select cb.github_watches() as w`)[0].w.watches.length, 3, 'no project: all, never the outbox');
  // the writes are Ahmed's, with cb github's words
  await assert.rejects(session()`select cb.github_watch_add('acme/four', project => 'demo', tell => 'x', actor => 'W1@pc')`, /^.*only Ahmed adds or removes watched repos: ask him to \(cb ask\), saying which repo and why$/);
  await assert.rejects(session()`select cb.github_watch_remove('acme/one', 'W1@pc')`, /only Ahmed adds or removes watched repos/);
  await assert.rejects(session()`select cb.github_mute('x', false, 'W1@pc')`, /only Ahmed mutes or unmutes GitHub logins/);
});

// Through the proxy with a signed-in admin, as auth.test.ts does it.
const SITE = 'board.example.com';
const web = (path: string, o: { cookie?: string; body?: object } = {}) =>
  app.request(path, { method: o.body ? 'POST' : 'GET', headers: {
    host: SITE, 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https', origin: `https://${SITE}`, 'sec-fetch-site': 'same-origin',
    ...(o.body ? { 'content-type': 'application/json' } : {}), ...(o.cookie ? { cookie: `cb_user=${o.cookie}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined });
async function signIn(name: string, password: string) {
  const r = await web('/api/login', { body: { name, password } });
  return /cb_user=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1]!;
}

test('the server: only Ahmed saves project settings; another admin reads them and keeps the pipeline and reminders', async () => {
  const sql = await db();
  await sql`select cb.user_add('ahmed', 'Ahmed', role => 'admin')`;
  await sql`select cb.user_password('ahmed', 'owner-pass-1')`;
  await sql`select cb.user_add('cai', 'Cai', role => 'admin')`;
  await sql`select cb.user_password('cai', 'cai-pass-1')`;
  await sql`select cb.ensure_project('demo')`;
  const cai = await signIn('cai', 'cai-pass-1'), ahmed = await signIn('ahmed', 'owner-pass-1');
  const writes: [string, object][] = [
    ['squad_set', { project: 'demo', squad: SQUAD, base: 0 }],
    ['role_text_set', { role: 'builder', body: 'x' }],
    ['role_text_import', { texts: { qa: 'Check it on dev.' } }],
    ['project_role_set', { project: 'demo', addition: 'Plain words on screens.', ask_first: 'ahmed' }],
    ['github_watch_add', { repo: 'acme/one', project: 'demo', tell: 'orch@pc' }],
    ['github_mute', { login: 'someone' }],
    ['github_watch_remove', { repo: 'acme/one' }],
    ['project_auto_backup', { project: 'demo', enabled: true }], // #4787 (Q3157): Ahmed's alone
  ];
  for (const [fn, body] of writes) {
    const r = await web(`/api/rpc/${fn}`, { cookie: cai, body });
    assert.equal(r.status, 403, fn);
    assert.deepEqual(await r.json(), { ok: false, error: 'Only Ahmed changes project settings.' }, fn);
  }
  assert.equal((await sql`select squad from cb.projects where slug = 'demo'`)[0].squad, null);
  assert.equal((await sql`select count(*)::int as n from cb.project_role_settings`)[0].n, 0);
  for (const [fn, body] of [['squad_page', { project: 'demo' }], ['squad_options', {}], ['role_text_page', {}], ['project_role_page', { project: 'demo' }], ['github_watches', { project: 'demo' }],
    ['project_pipeline', { project: 'demo', enabled: true }], ['task_ping_bulk', { project: 'demo', enabled: true }]] as [string, object][]) {
    const r = await web(`/api/rpc/${fn}`, { cookie: cai, body });
    assert.equal(r.status, 200, `${fn}: ${await r.clone().text()}`);
  }
  for (const [fn, body] of writes) {
    const r = await web(`/api/rpc/${fn}`, { cookie: ahmed, body });
    assert.equal(r.status, 200, `${fn}: ${await r.clone().text()}`);
  }
  assert.equal((await sql`select squad_version as v from cb.projects where slug = 'demo'`)[0].v, 1);
  assert.equal((await sql`select updated_by from cb.role_texts where role = 'builder'`)[0].updated_by, 'ahmed');
  const [pr] = await sql`select addition, ask_first, updated_by from cb.project_role_settings where project = 'demo'`;
  assert.deepEqual([pr?.addition, pr?.ask_first, pr?.updated_by], ['Plain words on screens.', 'ahmed', 'ahmed']);
  assert.equal((await sql`select body from cb.role_texts where role = 'qa'`)[0].body, 'Check it on dev.');
  // #4525: the texts this release ships, for "Load the new texts": the repo's files, to any admin; never to a guest
  const seeds = await web('/api/role-text-seeds', { cookie: cai });
  assert.equal(seeds.status, 200);
  const shipped = await seeds.json();
  assert.deepEqual(Object.keys(shipped).sort(), ['_common', 'architect', 'builder', 'investigator', 'lead', 'owner', 'qa', 'reviewer']);
  assert.equal(shipped.builder, readFileSync('prompts/roles/builder.md', 'utf8').trim());
  assert.equal((await web('/api/role-text-seeds')).status, 401, 'not signed in');
  const [{ token: gus }] = await sql`select cb.user_add('gus', 'Gus') as token`; // a guest (member), signed in by link
  const guest = await web('/api/role-text-seeds', { cookie: gus });
  assert.equal(guest.status, 403, 'a signed-in guest');
  assert.deepEqual(await guest.json(), { ok: false, error: 'not available to guests' });
  // the local dashboard is Ahmed
  const local = await app.request('/api/rpc/role_text_set', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost:4747', origin: 'http://localhost:4747' },
    body: JSON.stringify({ role: 'builder', body: 'from the local dashboard', actor: 'ahmed' }) });
  assert.equal(local.status, 200, await local.clone().text());
});
