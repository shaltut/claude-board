import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; }

// No server is running: the CLI must talk to Postgres directly.
function cb(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('node', ['cli/cb.ts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'W1@test', HERDR_PANE_ID: '', ...env },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test('add prints id', async () => {
  await db();
  const r = cb(['add', 'demo', 'Fix RI grading', '-p', 'P1']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '#1');
});

test('next claims and prints', async () => {
  const sql = await db();
  cb(['add', 'demo', 'Top task', '-s', 'next']);
  const r = cb(['next', 'demo']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^#1 /);
  const [t] = await sql`select status, assignee from cb.tasks where id = 1`;
  assert.equal(t.status, 'in_progress');
  assert.equal(t.assignee, 'W1@test');
});

test('ask captures pane', async () => {
  const sql = await db();
  const r = cb(['ask', 'demo', 'Rotate creds?', '-o', 'Now=before cutover', '-o', 'Friday', '--multi'], { HERDR_PANE_ID: 'p7' });
  assert.equal(r.code, 0, r.err);
  const [q] = await sql`select reply_to, options, multi from cb.questions where id = 1`;
  assert.equal(q.reply_to.pane, 'p7');
  assert.deepEqual(q.options, [{ label: 'Now', description: 'before cutover' }, { label: 'Friday', description: null }]);
  assert.equal(q.multi, true);
});

test('bad status exits 1 with message', async () => {
  await db();
  cb(['add', 'demo', 'T']);
  const r = cb(['move', '1', 'nope']);
  assert.equal(r.code, 1);
  assert.match(r.err, /use one of/);
});

test('done records links', async () => {
  const sql = await db();
  cb(['add', 'demo', 'T']);
  const r = cb(['done', '#1', 'merged', '--pr', '#412', '--commit', 'abc123']);
  assert.equal(r.code, 0, r.err);
  const [e] = await sql`select data from cb.events where kind = 'done'`;
  assert.deepEqual(e.data.links, { pr: '#412', commit: 'abc123' });
});

test('unreachable remote board fails fast with a clear message', () => {
  const t0 = Date.now();
  // 10.255.255.1 is a non-routable address: connections hang rather than refuse.
  const r = cb(['mine'], { CB_DATABASE_URL: 'postgres://cb@10.255.255.1:5434/claude_board' });
  assert.equal(r.code, 1);
  assert.match(r.err, /board unreachable at 10\.255\.255\.1/);
  assert.match(r.err, /keep working/);
  assert.ok(Date.now() - t0 < 15_000, `took ${Date.now() - t0}ms`);
});

test('unknown flag fails with a readable message, no stack', async () => {
  await db();
  const r = cb(['add', 'demo', 'x', '--label', 'foo']);
  assert.equal(r.code, 1);
  assert.match(r.err, /^cb: unknown option --label/);
  assert.doesNotMatch(r.err, /\n\s+at /);
});

test('text that starts with a dash is text', async () => {
  const sql = await db();
  const r = cb(['log', 'demo', '-5% latency after fix']);
  assert.equal(r.code, 0, r.err);
  const [e] = await sql`select summary from cb.events where kind = 'note'`;
  assert.equal(e.summary, '-5% latency after fix');
});

test('unknown command exits 1', async () => {
  await db();
  const r = cb(['list']);
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown command "list"/);
});

test('--reply-to sets where the answer goes; --as alone does not use my pane', async () => {
  const sql = await db();
  cb(['ask', 'demo', 'for a worker?', '--as', 'W2@mac', '--reply-to', 'macbook:w1:p3'], { HERDR_PANE_ID: 'orchpane' });
  cb(['ask', 'demo', 'no target', '--as', 'W2@mac'], { HERDR_PANE_ID: 'orchpane' });
  const rows = await sql`select reply_to from cb.questions order by id`;
  assert.deepEqual(rows[0].reply_to, { machine: 'macbook', pane: 'w1:p3' });
  assert.equal(rows[1].reply_to, null);
});
