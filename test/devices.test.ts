// Multi-user sessions, phase 2: the identity chain person → device → session, in SQL only (no route uses it yet).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { freshDb, onProject } from './helpers.ts'; // sets CB_DATABASE_URL before the server's db client loads

const clients: any[] = [];
let serverSql: any;
after(() => Promise.all([...clients.map((c) => c.end()), serverSql?.end()]));
async function db() { const s = await freshDb(); clients.push(s); return s; }

// A session's connection: anything but the dashboard's application_name.
const asSession = (sql: any, call: (tx: any) => Promise<any>) =>
  sql.begin(async (tx: any) => { await tx`set local application_name = 'psql'`; return call(tx); });

test('sessions switch: off by default, only the dashboard turns it on, and History says what it means', async () => {
  const sql = await db();
  await sql`select cb.user_add('omar', 'Omar')`;
  assert.equal((await sql`select sessions_on from cb.users where name = 'omar'`)[0].sessions_on, false);
  await assert.rejects(asSession(sql, (tx) => tx`select cb.user_sessions('omar', true, 'W1@pc')`), /only Ahmed can do this, on the Users page/);
  await sql`select cb.user_sessions('omar', true, 'ahmed')`;
  assert.equal((await sql`select sessions_on from cb.users where name = 'omar'`)[0].sessions_on, true);
  const [e] = await sql`select actor, summary, data from cb.events where kind = 'user' order by id desc limit 1`;
  assert.equal(e.actor, 'ahmed');
  assert.equal(e.summary, 'Omar (omar) may now connect sessions: work on their projects will reach their machine');
  assert.deepEqual(e.data, { user: 'omar', action: 'sessions_on' });
  await sql`select cb.user_sessions('omar', true, 'ahmed')`; // again: no second line
  assert.equal((await sql`select count(*)::int as n from cb.events where data ->> 'action' = 'sessions_on'`)[0].n, 1);
  await assert.rejects(sql`select cb.user_sessions('nobody', true, 'ahmed')`, /unknown user nobody: see cb users/);
  await sql`select cb.user_sessions('omar', false, 'ahmed')`;
  assert.equal((await sql`select summary from cb.events order by id desc limit 1`)[0].summary, 'Omar (omar) may no longer connect sessions');
});

async function omar(sql: any) {
  await sql`select cb.user_add('omar', 'Omar')`;
  await onProject(sql, 'omar', 'ihop');
  await sql`select cb.user_sessions('omar', true, 'ahmed')`;
}
const add = async (sql: any, label: string, name = 'omar') => (await sql`select cb.device_add(${name}, ${label}, 'ahmed') as t`)[0].t as string;
const auth = async (sql: any, t: string | null) => (await sql`select cb.device_auth(${t}) as r`)[0].r;

test('device: the token is shown once, stored only as a hash, and never reaches History', async () => {
  const sql = await db(); await omar(sql);
  const t = await add(sql, 'omar-laptop');
  assert.match(t, /^cbd_[0-9a-f]{64}$/);
  const [d] = await sql`select * from cb.devices`;
  assert.equal(d.token_hash, (await sql`select encode(public.digest(${t}, 'sha256'), 'hex') as h`)[0].h);
  assert.doesNotMatch(JSON.stringify(await sql`select * from cb.devices`), new RegExp(t));
  assert.doesNotMatch(JSON.stringify(await sql`select * from cb.events`), new RegExp(t));
  const [e] = await sql`select summary, data from cb.events where kind = 'user' order by id desc limit 1`;
  assert.equal(e.summary, 'device omar-laptop added for Omar (omar)');
  assert.deepEqual(e.data, { user: 'omar', action: 'device_add', device: Number(d.id), label: 'omar-laptop' });
});

test('device: authenticates to its person and their projects, and to nothing else', async () => {
  const sql = await db(); await omar(sql);
  const t = await add(sql, 'omar-laptop');
  const [d] = await sql`select id from cb.devices`;
  assert.deepEqual(await auth(sql, t), { device: Number(d.id), user: 'omar', label: 'omar-laptop', role: 'member', projects: ['ihop'] });
  for (const bad of [null, '', 'cbd_' + '0'.repeat(64), t.slice(0, -1), t.toUpperCase()]) assert.equal(await auth(sql, bad), null, String(bad));
  assert.ok((await sql`select last_seen from cb.devices`)[0].last_seen, 'a successful auth records last_seen');
});

test('device: who may have one, and what it may be called', async () => {
  const sql = await db(); await omar(sql);
  await sql`select cb.user_add('iman', 'Iman')`;
  await assert.rejects(add(sql, 'iman-pc', 'iman'), /iman can't connect sessions yet: turn it on for them on the Users page/);
  await assert.rejects(add(sql, 'x', 'nobody'), /unknown user nobody: see cb users/);
  for (const bad of ['', 'A', 'Omar Laptop', '9lives', 'a', 'x'.repeat(32), 'ahmed-pc', 'has_underscore', 'orch'])
    await assert.rejects(add(sql, bad), /device name: 2 to 31 lowercase letters, digits or -, starting with a letter|reserved/, bad);
  // a machine one of Ahmed's own sessions already uses can't be a teammate's device: W1@macbook must stay his
  await sql`select cb.ensure_project('ihop')`;
  await asSession(sql, (tx) => tx`select cb.iam('MacBook', 'p1', 'W1@macbook', 'ihop')`);
  await assert.rejects(add(sql, 'macbook'), /macbook is already a machine on the board: pick another device name/);
  await add(sql, 'omar-laptop');
  await assert.rejects(add(sql, 'omar-laptop'), /omar-laptop is taken: pick another device name/);
  await sql`select cb.user_sessions('iman', true, 'ahmed')`;
  await assert.rejects(add(sql, 'omar-laptop', 'iman'), /omar-laptop is taken/, 'labels are unique across people');
  await assert.rejects(asSession(sql, (tx) => tx`select cb.device_add('omar', 'second', 'W1@pc')`), /only Ahmed can do this, on the Users page/);
  for (let i = 0; i < 9; i++) await add(sql, `omar-d${i}`);
  await assert.rejects(add(sql, 'omar-eleventh'), /omar has 10 devices: revoke one first/);
});

test('device: revoked means refused at once; the row and its label stay', async () => {
  const sql = await db(); await omar(sql);
  const t = await add(sql, 'omar-laptop');
  const [d] = await sql`select id from cb.devices`;
  await sql`select cb.device_revoke(${d.id}, 'ahmed')`;
  assert.equal(await auth(sql, t), null);
  await sql`select cb.device_revoke(${d.id}, 'ahmed')`; // twice is harmless
  assert.equal((await sql`select count(*)::int as n from cb.events where data ->> 'action' = 'device_revoke'`)[0].n, 1);
  assert.equal((await sql`select summary from cb.events order by id desc limit 1`)[0].summary, 'device omar-laptop revoked for Omar (omar)');
  await assert.rejects(add(sql, 'omar-laptop'), /omar-laptop is taken/);
  await assert.rejects(sql`select cb.device_revoke(999, 'ahmed')`, /device 999 not found: see the Users page/);
  const list = (await sql`select cb.devices_list('omar') as r`)[0].r;
  assert.deepEqual(Object.keys(list[0]).sort(), ['created_at', 'id', 'label', 'last_seen', 'revoked_at', 'user']);
  assert.ok(list[0].revoked_at);
});

test('device: every way a person loses access ends their devices', async () => {
  const sql = await db(); await omar(sql);
  const off = await add(sql, 'omar-a');
  await sql`select cb.user_sessions('omar', false, 'ahmed')`;
  assert.equal(await auth(sql, off), null, 'switch off');
  assert.equal((await sql`select summary from cb.events order by id desc limit 1`)[0].summary, 'Omar (omar) may no longer connect sessions: 1 device revoked');
  await sql`select cb.user_sessions('omar', true, 'ahmed')`;
  assert.equal(await auth(sql, off), null, 'switching back on does not revive an old token');

  const role = await add(sql, 'omar-b');
  await sql`select cb.user_add('ahmed', 'Ahmed', 'ahmed', 'admin')`; // the board always has its owner: omar is never the last admin
  await sql`select cb.user_set_role('omar', 'admin', 'ahmed')`;
  assert.equal(await auth(sql, role), null, 'a role change ends every sign-in, devices included');
  await sql`select cb.user_set_role('omar', 'member', 'ahmed')`;

  const proj = await add(sql, 'omar-c');
  await onProject(sql, 'omar', 'evicare');
  assert.deepEqual((await auth(sql, proj)).projects, ['evicare', 'ihop']);
  await sql`select cb.user_project_remove('omar', 'ihop', 'ahmed')`;
  assert.deepEqual((await auth(sql, proj)).projects, ['evicare'], 'taken off a project: gone from the next auth');

  await sql`select cb.user_remove('omar', 'ahmed')`;
  assert.equal(await auth(sql, proj), null, 'removed');
  assert.equal((await sql`select count(*)::int as n from cb.devices`)[0].n, 0);
});

test('device: listing is the dashboard\'s, live devices first', async () => {
  const sql = await db(); await omar(sql);
  await add(sql, 'omar-old'); await add(sql, 'omar-laptop');
  await sql`select cb.device_revoke((select id from cb.devices where label = 'omar-old'), 'ahmed')`;
  await assert.rejects(asSession(sql, (tx) => tx`select cb.devices_list()`), /only Ahmed can do this, on the Users page/);
  assert.deepEqual((await sql`select cb.devices_list() as r`)[0].r.map((d: any) => d.label), ['omar-laptop', 'omar-old']);
  assert.doesNotMatch(JSON.stringify((await sql`select cb.devices_list() as r`)[0].r), /hash/);
});

test('events: a write made for a person records them; everything else is unchanged', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('ihop')`;
  await sql`select cb.log(project => 'ihop', summary => 'direct', actor => 'W1@pc')`;
  await sql.begin(async (tx: any) => {
    await tx`select set_config('cb.owner', 'omar', true)`;
    await tx`select cb.log(project => 'ihop', summary => 'for omar', actor => 'W1@omar-laptop')`;
  });
  await sql`select cb.log(project => 'ihop', summary => 'after', actor => 'W1@pc')`;
  const rows = await sql`select summary, owner from cb.events where kind = 'note' order by id`;
  assert.deepEqual(rows.map((r: any) => [r.summary, r.owner]), [['direct', null], ['for omar', 'omar'], ['after', null]]);
});

test('sessions: an existing binding has no person; iam still works as before', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('ihop'), cb.iam('PC', 'p1', 'W1@pc', 'ihop')`;
  const [s] = await sql`select actor, user_name, device_id from cb.sessions`;
  assert.deepEqual({ ...s }, { actor: 'W1@pc', user_name: null, device_id: null });
});

test('sessions: revoking a device unbinds the sessions that came in through it, and no others', async () => {
  const sql = await db(); await omar(sql);
  await add(sql, 'omar-laptop');
  const [d] = await sql`select id from cb.devices`;
  await sql`select cb.iam('PC', 'p1', 'W1@pc', 'ihop')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, user_name, device_id) values ('omar-laptop', 's1', 'W1@omar-laptop', 'ihop', 'omar', ${d.id})`;
  await sql`select cb.device_revoke(${d.id}, 'ahmed')`;
  assert.deepEqual((await sql`select actor from cb.sessions`).map((s: any) => s.actor), ['W1@pc']);
});

test('schema: re-running setup keeps devices, switches and old sessions', async () => {
  const sql = await db(); await omar(sql);
  const t = await add(sql, 'omar-laptop');
  await sql`select cb.iam('PC', 'p1', 'W1@pc', 'ihop')`;
  execFileSync('node', ['db/setup.ts', '--test'], { stdio: 'pipe' });
  execFileSync('node', ['db/setup.ts', '--test'], { stdio: 'pipe' });
  assert.equal((await auth(sql, t)).user, 'omar');
  assert.equal((await sql`select count(*)::int as n from cb.sessions where user_name is null`)[0].n, 1);
});

test('none of this is reachable over HTTP yet', async () => {
  const { RPC_FUNCTIONS } = await import('../server/rpc.ts');
  serverSql = (await import('../server/db.ts')).sql;
  for (const fn of ['user_sessions', 'device_add', 'device_auth', 'device_revoke', 'devices_list']) assert.ok(!RPC_FUNCTIONS.includes(fn), fn);
});
