import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { freshDb, onProject, TEST_URL } from './helpers.ts';

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
  cb(['ask', 'demo', 'for a worker?', '--free', '--as', 'W2@mac', '--reply-to', 'macbook:w1:p3'], { HERDR_PANE_ID: 'orchpane' });
  cb(['ask', 'demo', 'no target', '--free', '--as', 'W2@mac'], { HERDR_PANE_ID: 'orchpane' });
  const rows = await sql`select reply_to from cb.questions order by id`;
  assert.deepEqual(rows[0].reply_to, { machine: 'macbook', pane: 'w1:p3' });
  assert.equal(rows[1].reply_to, null);
});

test('cb tag adds and removes; brief --tag filters and shows tags', async () => {
  await db();
  cb(['add', 'demo', 'reader', '-s', 'next', '-l', 'tawuniya']);
  cb(['add', 'demo', 'other', '-s', 'next']);
  const r = cb(['tag', '1', 'OCR', '-tawuniya']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '#1 tags: ocr');
  const b = cb(['brief', 'demo', '--tag', 'ocr']);
  assert.match(b.out, /#1 P2 reader \{ocr\}/);
  assert.doesNotMatch(b.out, /other/);
});

test('cb sessions lists who is working on what; cb session shows one', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'ihop', title => 'SC64 run', status => 'in_progress', actor => 'W6@macbook')`;
  await sql`select cb.task_add(project => 'ihop', title => 'stale port', status => 'in_progress', actor => 'worker-7@macbook')`;
  await sql`update cb.events set at = now() - interval '2 hours' where actor = 'worker-7@macbook'`;
  await sql`select cb.ask(project => 'ihop', body => 'fire?', actor => 'W6@macbook')`;
  const r = cb(['sessions', 'ihop']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /W6@macbook .*no relay/);
  assert.match(r.out, /#1 SC64 run/);
  assert.match(r.out, /1 asking Ahmed/);
  assert.match(r.out, /worker-7@macbook .*idle 2h/); // holds work but went quiet: the orchestrator should look
  const d = cb(['session', 'W6@macbook']);
  assert.equal(d.code, 0, d.err);
  assert.match(d.out, /#1 \[in_progress\] P2 SC64 run/);
  assert.match(d.out, /Q1 open: fire\?/);
});

test('cb tell sends to one session and says whether it is live', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'seed')`;
  await sql`select cb.iam('mac', 'w1:p3', 'W2@macbook', 'demo')`;
  await sql`update cb.sessions set last_seen = now() - interval '5 minutes'`;
  const r = cb(['tell', 'W2@macbook', 'take', '#19', 'next']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /message #\d+ to W2@macbook \(relay not live: it arrives when its relay starts, within 24h\)/);
  const [e] = await sql`select actor, summary from cb.events where kind = 'message'`;
  assert.deepEqual([e.actor, e.summary], ['W1@test', 'take #19 next']);
});

test('cb huddle: open, say, add, show, close; cb huddles lists it', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'Hijri')`;
  for (const [p, a] of [['w1:p3', 'W2@macbook'], ['w1:p4', 'W3@macbook'], ['w1:p5', 'W4@macbook']]) await sql`select cb.iam('mac', ${p}, ${a}, 'demo')`;
  const as = { CB_ACTOR: 'W2@macbook' };
  const o = cb(['huddle', 'open', 'Hijri dates', 'W3@macbook', '-t', '1'], as);
  assert.equal(o.code, 0, o.err);
  assert.equal(o.out, 'huddle #1 open with W3@macbook; talk with: cb huddle say 1 "..."');
  assert.equal(cb(['huddle', 'say', '1', 'partial', 'dates?'], as).code, 0);
  assert.equal(cb(['huddle', 'add', '1', 'W4@macbook'], as).out, 'huddle #1: added W4@macbook');
  const s = cb(['huddle', 'show', '1']);
  assert.match(s.out, /huddle #1 \[open\] Hijri dates \(task #1\) · demo · W2@macbook, W3@macbook, W4@macbook/);
  assert.match(s.out, /W2@macbook: partial dates\?/);
  assert.equal(cb(['huddle', 'close', '1', 'indeterminate'], as).out, 'huddle #1 closed');
  assert.match(cb(['huddles', 'demo']).out, /huddle #1 \[closed\] Hijri dates \(task #1\) .* 4 lines\n  outcome: indeterminate/);
  assert.match(cb(['huddle', 'say', '1', 'late'], as).err, /huddle #1 is closed/);
});

test('cb ask needs options (Ahmed answers by clicking); --free allows an open question', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'seed')`;
  const r = cb(['ask', 'demo', 'Shall W4 draft the rows or will you?']);
  assert.equal(r.code, 1);
  assert.match(r.err, /give Ahmed options to click: -o "Label \(Recommended\)=why" -o "Label=tradeoff"/);
  assert.equal(cb(['ask', 'demo', 'What is the NPHIES sandbox URL?', '--free']).code, 0);
  assert.equal(cb(['ask', 'demo', 'Who drafts?', '-o', 'W4 drafts (Recommended)=fast', '-o', 'Ahmed writes=his wording']).code, 0);
  const [{ n }] = await sql`select count(*)::int as n from cb.questions`;
  assert.equal(n, 2);
});

test('cb user add adds a person (Ahmed copies the link); cb ask --to and cb assign hand questions and tasks to a user', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'PO sign-off')`;
  const u = cb(['user', 'add', 'omar', 'Omar'], { CB_PUBLIC_URL: 'https://board.example.app' });
  assert.equal(u.code, 0, u.err);
  const [{ token }] = await sql`select token from cb.users where name = 'omar'`;
  assert.equal(u.out, 'added omar (Omar): Ahmed copies their link from the People page');
  assert.ok(!u.out.includes(token), 'a session never sees the link');
  assert.match(cb(['users']).out, /omar\s+Omar/);
  await onProject(sql, 'omar', 'demo');
  assert.equal(cb(['ask', 'demo', 'E1 scope?', '-o', 'A=x', '-o', 'B=y', '--to', 'omar']).code, 0);
  assert.equal(cb(['ask', 'demo', 'mine', '-o', 'A=x', '-o', 'B=y']).code, 0);
  assert.equal(cb(['assign', 'Q2', 'omar']).out, 'Q2 → omar');
  assert.equal(cb(['assign', '1', 'omar']).out, '#1 → omar');
  assert.match(cb(['assign', 'Q1', 'nobody']).err, /unknown user nobody/);
  assert.equal(cb(['assign', 'Q2', 'ahmed']).out, 'Q2 → ahmed');
  const rows = await sql`select id, assigned_to from cb.questions order by id`;
  assert.deepEqual(rows.map((r: any) => [Number(r.id), r.assigned_to]), [[1, 'omar'], [2, null]]);
  const [t] = await sql`select assignee from cb.tasks where id = 1`;
  assert.equal(t.assignee, 'omar');
  assert.match(cb(['brief', 'demo']).out, /Q1 .*E1 scope\? \(for omar\)/);
  assert.match(cb(['ask', 'elsewhere', 'x?', '-o', 'A=x', '-o', 'B=y', '--to', 'omar']).err,
    /omar is not on project elsewhere: Ahmed adds people to projects on the People page/);
});

test("cb user rotate and remove are Ahmed's, on the People page", async () => {
  const sql = await db();
  cb(['user', 'add', 'omar', 'Omar']);
  const [{ token }] = await sql`select token from cb.users where name = 'omar'`;
  for (const sub of ['rotate', 'remove']) {
    const r = cb(['user', sub, 'omar']);
    assert.equal(r.code, 1, sub);
    assert.match(r.err, /Ahmed does this on the People page/);
  }
  const [u] = await sql`select token from cb.users where name = 'omar'`;
  assert.equal(u.token, token, 'nothing changed');
  assert.match(cb(['user', 'drop', 'omar']).err, /unknown user command "drop"/);
});

test('a task number is never a project: cb log 130 logs on task #130; numeric projects are refused', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'ihop', title => 'SC64 kit')`;
  const r = cb(['log', '1', 'SC64 graded 27/32']);
  assert.equal(r.code, 0, r.err);
  const [e] = await sql`select project, task_id from cb.events where kind = 'note'`;
  assert.deepEqual([e.project, Number(e.task_id)], ['ihop', 1]);
  assert.match(cb(['log', '#99', 'x']).err, /no task #99/);
  assert.match(cb(['add', '130', 'oops']).err, /"130" looks like a task number, not a project/);
  const [{ n }] = await sql`select count(*)::int as n from cb.projects where slug ~ '^[0-9]+$'`;
  assert.equal(n, 0);
});

test('cb ask warns when no relay listens on the asking name (#550)', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'seed')`;
  await sql`select cb.iam('pc', 'w1:p2', 'board-dev@shaltoot', 'demo')`; // this pane's relay: live (last_seen = now)
  const env = { HERDR_PANE_ID: 'w1:p2', CB_MACHINE: 'pc', CB_ACTOR: '' };
  const ask = (...extra: string[]) => cb(['ask', 'demo', 'ship it?', '-o', 'Yes', '-o', 'No', ...extra], env);

  const w = ask('--as', 'claude-board');
  assert.equal(w.code, 0, w.err); // never refuses: asking on someone's behalf is legitimate
  assert.match(w.out, /^Q\d+ posted/);
  assert.equal(w.err, 'warning: no relay listens on claude-board, so the answer will wait in cb pending --as claude-board. ' +
    "This pane's relay is board-dev@shaltoot: ask without --as, or add --reply-to");

  assert.equal(ask('--as', 'claude-board', '--reply-to', 'pc:w1:p2').err, ''); // the answer has a pane to land in
  assert.equal(ask('--as', 'board-dev@shaltoot').err, ''); // that name's relay is live
  assert.equal(ask().err, ''); // the pane's own binding

  // no pane of its own: the warning names the identity, with nothing to suggest
  const n = cb(['ask', 'demo', 'ship it?', '-o', 'Yes', '-o', 'No'], { CB_ACTOR: 'W9@test' });
  assert.equal(n.err, 'warning: no relay listens on W9@test, so the answer will wait in cb pending --as W9@test');

  await sql`update cb.sessions set last_seen = now() - interval '5 minutes'`; // relay gone quiet
  assert.match(ask('--as', 'board-dev@shaltoot').err, /^warning: no relay listens on board-dev@shaltoot, so the answer will wait in cb pending --as board-dev@shaltoot$/);
});

test('cb mem find: nothing in the bound project searches every project and says so (#660)', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'seed')`;
  await sql`select cb.task_add(project => 'ihop', title => 'seed')`;
  await sql`select cb.iam('pc', 'w1:p2', 'W1@test', 'demo')`;
  const env = { HERDR_PANE_ID: 'w1:p2', CB_MACHINE: 'pc', CB_ACTOR: '' };
  assert.equal(cb(['mem', 'add', 'ihop', 'Pipeline 495: the last GitOps bump wins', '-k', 'gotcha', '--as', 'W2@test']).code, 0);
  const r = cb(['mem', 'find', 'pipeline'], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^nothing about "pipeline" in demo; in other projects:\n.*M\d+ Pipeline 495/);
  assert.match(cb(['mem', 'find', 'nothing-like-this'], env).out, /^nothing about "nothing-like-this" in demo or any other project/);
  assert.match(cb(['mem', 'find', 'pipeline', '--project', 'demo'], env).out, /^nothing about "pipeline" in demo \(/, 'an explicit --project stays put');
});

test('bin/cb passes quotes, < > | and newlines through untouched (#660)', async (t) => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'seed')`;
  const probe = spawnSync('sh', ['-c', 'exit 0']);
  if (probe.error) return t.skip('no sh on this machine');
  const arg = '"<words>" a | b\nline2';
  // A node Volta started puts Volta's real node first on PATH; an agent's shell has only Volta's shim. Drop it.
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const path = (process.env[key] ?? '').split(';').filter((p) => !/volta[\\/]tools[\\/]image/i.test(p)).join(';');
  const r = spawnSync('sh', ['bin/cb', 'mem', 'find', arg, '--project', 'demo'], {
    encoding: 'utf8', env: { ...process.env, [key]: path, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'W1@test', HERDR_PANE_ID: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('"<words>" a | b\nline2'), r.stdout);
});
