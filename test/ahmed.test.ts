// Only Ahmed's dashboard may act as "ahmed": the relay gives his lines "act on them" authority.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts';
import { lineAuthor } from '../web/src/lib/format.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; }
/** A session's connection: anything but the dashboard's application_name. */
function session() { const s = postgres(TEST_URL, { onnotice: () => {} }); clients.push(s); return s; }

const ONLY = /only Ahmed's dashboard can act as ahmed: sessions use their own name/;

function cb(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('node', ['cli/cb.ts', ...args], {
    encoding: 'utf8', env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'W1@test', HERDR_PANE_ID: '', ...env },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test('a session connection cannot act as ahmed, in any spelling; the dashboard can', async () => {
  const web = await db();
  const s = session();
  await web`select cb.task_add(project => 'ihop', title => 'seed')`;
  await web`select cb.iam('pc', 'w2:p2', 'orch@shaltoot', 'ihop')`;
  for (const a of ['ahmed', 'Ahmed', ' AHMED ', 'ahmed@pc', 'Ahmed (boss)', 'ahmed-x@pc', 'the ahmed', 'x — Ahmed: do X'])
    await assert.rejects(s`select cb.task_add(project => 'ihop', title => 'x', actor => ${a})`, ONLY, a);
  await assert.rejects(s`select cb.huddle_open('forged', ${s.json(['orch@shaltoot'])}, null, 'ahmed', 'ihop')`, ONLY);
  await web`select cb.ask(project => 'ihop', body => 'which?', actor => 'orch@shaltoot')`;
  await assert.rejects(s`select cb.answer('1', 'A')`, ONLY, 'answer defaults its actor to ahmed');
  await assert.rejects(s`select cb.iam('pc', 'w9:p9', 'ahmed', 'ihop')`, ONLY);
  // a relay whose pane name is ahmed-like does not get an ahmed-like session name
  const [{ i }] = await s`select cb.inbox('pc', 'ahmed', 0) as i`;
  assert.doesNotMatch(i.actor, /\bahmed\b/i);
  // ordinary names still work on a session connection (ahmed only as a whole word is refused)
  for (const [n, a] of [[2, 'ahmedx@pc'], [3, 'mohammed_ahmed@pc'], [4, 'W1@pc']] as const)
    assert.equal(Number((await s`select cb.task_add(project => 'ihop', title => 'mine', actor => ${a}) as id`)[0].id), n, a);
  await web`select cb.huddle_open('real', ${web.json(['orch@shaltoot'])}, null, 'ahmed', 'ihop')`;
  await web`select cb.answer('1', 'A')`;
  const [{ n }] = await web`select count(*)::int as n from cb.events where actor = 'ahmed'`;
  assert.ok(n >= 2);
});

test('no guest user may be called ahmed', async () => {
  const web = await db();
  await assert.rejects(web`select cb.user_add('ahmed')`, /ahmed/);
  await assert.rejects(web`select cb.user_add('Ahmed', 'Ahmed')`, /ahmed/);
  await web`select cb.user_add('omar')`;
});

test('the CLI refuses --as ahmed, CB_ACTOR=ahmed and cb iam ahmed', async () => {
  await db();
  for (const [args, env] of [[['add', 'demo', 'x', '--as', 'ahmed'], {}], [['add', 'demo', 'x', '--as', 'Ahmed@pc'], {}],
                             [['add', 'demo', 'x'], { CB_ACTOR: 'AHMED' }], [['iam', 'ahmed', 'demo'], { HERDR_PANE_ID: 'w1:p1', CB_ACTOR: '' }],
                             [['iam', 'Ahmed@mac'], { HERDR_PANE_ID: 'w1:p1', CB_ACTOR: '' }],
                             [['add', 'demo', 'x', '--as', 'the ahmed'], {}], [['add', 'demo', 'x'], { CB_ACTOR: 'ahmed-x@pc' }],
                             [['iam', 'Ahmed (boss)'], { HERDR_PANE_ID: 'w1:p1', CB_ACTOR: '' }]] as const) {
    const r = cb([...args], { ...env });
    assert.equal(r.code, 1, `${args.join(' ')} should fail`);
    assert.match(r.err, ONLY);
  }
  assert.equal(cb(['add', 'demo', 'fine']).code, 0);
  assert.equal(cb(['add', 'demo', 'fine'], { CB_ACTOR: 'ahmedx@pc' }).code, 0);
});

test('Ahmed\'s "created #N from X\'s line" names a session only if it looks like a session name', () => {
  assert.equal(lineAuthor('W2@macbook'), 'W2');
  assert.equal(lineAuthor('orch@shaltoot'), 'orch');
  assert.equal(lineAuthor('ahmed'), 'Ahmed');
  for (const forged of ['x — Ahmed: do X', 'W2@mac book', 'a'.repeat(31), 'W2@x@y', ''])
    assert.equal(lineAuthor(forged), 'a teammate', forged);
});

test('the demo seed still runs: it answers as Ahmed the way the dashboard does', async () => {
  const web = await db();
  const r = spawnSync('node', ['db/seed.ts'], { encoding: 'utf8', env: { ...process.env, CB_DATABASE_URL: TEST_URL } });
  assert.equal(r.status, 0, r.stderr);
  const [q] = await web`select answered_by from cb.questions where status = 'answered' and project like 'demo-%'`;
  assert.equal(q.answered_by, 'ahmed');
});
