// #4787 (Q3157): the supervisor may move a seat stopped by its model's quota to the squad's backup, only in a project
// where Ahmed turned that on. The rules, in SQL.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
const conn = (name: string) => { const c = postgres(TEST_URL, { onnotice: () => {}, connection: { application_name: name } }); clients.push(c); return c; };

const BACKUPS = [{ agent: 'claude', model: 'haiku' }, { agent: 'claude', model: 'opus' }];
const SQUAD = {
  machines: { macbook: { herdr: 'macbook', repo: '/Users/me/Work/x', board: '/Users/me/Work/claude-board' } },
  roles: { lead: { count: 1, model: 'opus', machine: 'macbook' }, builder: { count: 2, model: 'sonnet', machine: 'macbook', fallback: BACKUPS } },
  areas: [], supervise: true,
};
const B1 = 'sv-B1@macbook';

async function setup() {
  const sql = await freshDb(); clients.push(sql);
  await sql`select cb.ensure_project('sv')`;
  await sql`select cb.project_pipeline('sv', true, 'ahmed')`;
  await sql`select cb.squad_set('sv', ${sql.json(SQUAD)}, 'ahmed')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role) values ('macbook','p0','orch@macbook','sv','lead'),
    ('macbook','p1',${B1},'sv','builder'), ('macbook','p2','sv-B2@macbook','sv','builder')`;
  return { sql, sup: conn('cb-supervisor/test'), seat: conn('cb-test/session') };
}
const state = async (sup: any) => (await sup`select cb.supervise_state('sv') as r`)[0].r;
const of = async (sup: any, actor = B1) => (await state(sup)).sessions.find((x: any) => x.actor === actor);
const on = (sql: any, enabled = true) => sql`select cb.project_auto_backup('sv', ${enabled}, 'ahmed') as r`;
const switchTo = async (sup: any, n: number, actor = B1) => (await sup`select cb.seat_switch('sv', ${actor}, ${n}) as r`)[0].r;
const backups = async (sql: any) => (await sql`select count(*)::int as n from cb.seat_backups`)[0].n;

test('the automatic backup switch is off until Ahmed turns it on from the dashboard', async () => {
  const { sql, sup, seat } = await setup();
  assert.equal((await state(sup)).auto_backup, false);
  for (const c of [seat, sup]) {
    await assert.rejects(c`select cb.project_auto_backup('sv', true, 'orch@macbook')`, /only Ahmed can do this/);
    await assert.rejects(c`select cb.project_auto_backup('sv', true)`, /only Ahmed can do this/);
  }
  await assert.rejects(sql`select cb.project_auto_backup('sv', true, 'cai')`, /only Ahmed/);
  await assert.rejects(sql`select cb.project_auto_backup('sv', null, 'ahmed')`, /on or off/);
  assert.equal((await state(sup)).auto_backup, false);
  assert.equal((await on(sql))[0].r, true);
  assert.equal((await state(sup)).auto_backup, true);
  assert.equal((await sql`select cb.squad_page('sv') as r`)[0].r.auto_backup, true);
});

test("seat_switch records the squad's n-th backup: supervisor only, only while on, only a builder or other seat it names", async () => {
  const { sql, sup } = await setup();
  await assert.rejects(sql`select cb.seat_switch('sv', ${B1}, 1)`, /only the supervisor can do this/);
  await assert.rejects(switchTo(sup, 1), /automatic backup is off/);
  await on(sql);
  await assert.rejects(switchTo(sup, 3), /no backup 3/);
  await assert.rejects(switchTo(sup, 0), /no backup 0/);
  await assert.rejects(switchTo(sup, 1, 'orch@macbook'), /the lead is never switched/);
  assert.equal(await backups(sql), 0);
  assert.deepEqual(await switchTo(sup, 1), { n: 1, agent: 'claude', model: 'haiku' });
  assert.deepEqual((await of(sup)).backup, { n: 1, agent: 'claude', model: 'haiku' });
  assert.equal((await of(sup, 'sv-B2@macbook')).backup, null);
  // what the seat should run is its backup now: the settings page and the digest do not call it wrong
  const want = async (a: string) => (await sql`select cb._seat_want('sv', ${a}, 'builder', null, null) ->> 'model' as m, cb._expected_model('sv', ${a}, 'builder', null, null, 'claude') as e`)[0];
  assert.deepEqual({ ...(await want(B1)) }, { m: 'haiku', e: 'haiku' });
  assert.deepEqual({ ...(await want('sv-B2@macbook')) }, { m: 'sonnet', e: 'sonnet' });
  assert.deepEqual(await switchTo(sup, 2), { n: 2, agent: 'claude', model: 'opus' });
  assert.equal(await backups(sql), 1);
});

test("a backup ends with a changed squad, with the lead's or Ahmed's command, and when the switch is turned off", async () => {
  const { sql, sup, seat } = await setup();
  await on(sql);
  await switchTo(sup, 1);
  await sql`select cb.squad_set('sv', ${sql.json(SQUAD)}, 'ahmed')`; // nothing changed: no save
  assert.equal(await backups(sql), 1);
  await sql`select cb.squad_set('sv', ${sql.json({ ...SQUAD, roles: { ...SQUAD.roles, builder: { ...SQUAD.roles.builder, count: 3 } } })}, 'ahmed')`;
  assert.equal(await backups(sql), 0);

  await switchTo(sup, 1);
  await assert.rejects(seat`select cb.seat_backup_clear('sv', ${B1}, 'sv-B2@macbook')`, /only the project's lead or Ahmed/);
  assert.equal(await backups(sql), 1);
  assert.equal((await seat`select cb.seat_backup_clear('sv', ${B1}, 'orch@macbook') as r`)[0].r, true);
  assert.equal((await seat`select cb.seat_backup_clear('sv', ${B1}, 'orch@macbook') as r`)[0].r, false);
  await switchTo(sup, 1);
  assert.equal((await sql`select cb.seat_backup_clear('sv', ${B1}, 'ahmed') as r`)[0].r, true);

  await switchTo(sup, 1);
  await on(sql, false);
  assert.equal(await backups(sql), 0, 'off: no seat stays on an automatic backup');
});

test('a held card does not stop a close for a switch, only while the switch is on and the stop stands', async () => {
  const { sql, sup } = await setup();
  const [{ id }] = await sql`select cb.task_add(project => 'sv', title => 'c', type => 'bug', status => 'next', actor => 'orch@pc') as id`;
  await sql`update cb.tasks set assignee = ${B1}, status = 'in_progress' where id = ${id}`;
  const mark = async () => { const ok = (await sup`select cb.supervise_mark(${B1}, true) as r`)[0].r; await sup`select cb.supervise_mark(${B1}, false)`; return ok; };
  await on(sql);
  assert.equal(await mark(), false, 'no stop on the board');
  await sup`select cb.supervise_log('sv', 'quota', ${B1}, 'herdr pane p1')`;
  assert.equal(await mark(), true);
  await on(sql, false);
  assert.equal(await mark(), false, 'switch off');
  await on(sql);
  await sql`insert into cb.events (actor, project, kind, summary) values (${B1}, 'sv', 'note', 'working again')`;
  assert.equal(await mark(), false, 'the seat acted since');
});

test('only a squad the supervisor runs is switched; a switch ends the standing quota note, so the next stop needs two sightings again', async () => {
  const { sql, sup } = await setup();
  const [{ id }] = await sql`select cb.task_add(project => 'sv', title => 'c', type => 'bug', status => 'next', actor => 'orch@pc') as id`;
  await sql`update cb.tasks set assignee = ${B1}, status = 'in_progress' where id = ${id}`;
  await on(sql);
  await sup`select cb.supervise_log('sv', 'quota', ${B1}, 'herdr pane p1')`;
  for (const off of [() => sql`select cb.squad_set('sv', ${sql.json({ ...SQUAD, supervise: false })}, 'ahmed')`,
    () => sql`select cb.project_pipeline('sv', false, 'ahmed')`]) {
    await off();
    await assert.rejects(switchTo(sup, 1), /automatic backup is off/);
    assert.equal((await sup`select cb.supervise_mark(${B1}, true) as r`)[0].r, false);
    await sql`select cb.squad_set('sv', ${sql.json(SQUAD)}, 'ahmed')`;
    await sql`select cb.project_pipeline('sv', true, 'ahmed')`;
  }
  await sup`select cb.supervise_log('sv', 'quota', ${B1}, 'herdr pane p1')`;
  assert.equal((await of(sup)).quota_told, true);
  await switchTo(sup, 1);
  await sup`select cb.supervise_log('sv', 'switch', ${B1}, 'sonnet to haiku')`;
  assert.equal((await of(sup)).quota_told, false);
});

test('no_backup_told stands like quota_told; a switch and a missing backup have their digest lines', async () => {
  const { sql, sup } = await setup();
  assert.equal((await of(sup)).no_backup_told, false);
  await sup`select cb.supervise_log('sv', 'no_backup', ${B1}, 'herdr pane p1')`;
  assert.equal((await of(sup)).no_backup_told, true);
  await sql`insert into cb.events (actor, project, kind, summary) values (${B1}, 'sv', 'note', 'working again')`;
  assert.equal((await of(sup)).no_backup_told, false);
  await sup`select cb.supervise_log('sv', 'switch', 'sv-B2@macbook', 'sonnet to haiku')`;
  const d = (await sql`select cb.digest('sv', now() - interval '1 hour') as r`)[0].r;
  assert.ok(d.includes(`${B1} has no backup that can start: herdr pane p1`), JSON.stringify(d));
  assert.ok(d.includes('sv-B2@macbook switched to a backup: sonnet to haiku'), JSON.stringify(d));
});
