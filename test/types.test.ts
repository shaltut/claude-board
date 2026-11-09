// Task types (feature, bug, change, chore, research; default task) and the bug-report flow (cb bug).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; }

function cb(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('node', ['cli/cb.ts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'W1@test', HERDR_PANE_ID: '', ...env },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test('type: defaults to task, set at add and edit, normalized, unknown refused', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'old-style call, no type')`;
  await sql`select cb.task_add(project => 'demo', title => 'crash', type => ' BUG ')`;
  assert.deepEqual((await sql`select type from cb.tasks order by id`).map((r: any) => r.type), ['task', 'bug']);
  await sql`select cb.task_update('1', '{"type": "change"}', 'orch')`;
  const [t] = await sql`select type from cb.tasks where id = 1`;
  assert.equal(t.type, 'change');
  const [e] = await sql`select summary from cb.events where kind = 'updated'`;
  assert.equal(e.summary, 'edited type');
  await assert.rejects(sql`select cb.task_add(project => 'demo', title => 'x', type => 'epic')`, /unknown type "epic"; use one of task, bug, feature, change, chore, research/);
  await assert.rejects(sql`select cb.task_update('1', '{"type": "epic"}')`, /unknown type "epic"/);
  await assert.rejects(sql`update cb.tasks set type = 'epic'`, /tasks_type_check/);
});

test('brief --type filters; CLI lines mark non-default types only', async () => {
  const sql = await db();
  assert.equal(cb(['add', 'demo', 'plain work', '-s', 'next']).code, 0);
  const add = cb(['add', 'demo', 'login 500s', '-s', 'next', '--type', 'bug']);
  assert.equal(add.code, 0, add.err);
  const [{ type }] = await sql`select type from cb.tasks where id = 2`;
  assert.equal(type, 'bug');
  const all = cb(['brief', 'demo']).out;
  assert.match(all, /#1 P2 plain work/);
  assert.doesNotMatch(all, /task: plain work/);
  assert.match(all, /#2 .*P2 bug: login 500s/);
  const bugs = cb(['brief', 'demo', '--type', 'bug']).out;
  assert.match(bugs, /login 500s/);
  assert.doesNotMatch(bugs, /plain work/);
  assert.equal(cb(['edit', '1', '--type', 'research']).code, 0);
  assert.match(cb(['next', 'demo']).out, /^#1 .*P2 research: plain work/);
  const bad = cb(['edit', '2', '--type', 'epic']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /unknown type "epic"/);
});

test('cb bug files an unassigned P2 bug in Next and says who is told', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'ihop', title => 'seed')`;
  await sql`select cb.task_add(project => 'claude-board', title => 'seed2')`;
  await sql`select cb.iam('pc', 'w2:p2', 'orch@shaltoot', 'ihop')`;
  await sql`select cb.iam('mac', 'w1:p3', 'W2@macbook', 'ihop')`;
  await sql`select cb.iam('pc', 'w3:pA', 'board-dev@shaltoot', 'claude-board')`;
  const env = { CB_ACTOR: '', HERDR_PANE_ID: 'w1:p7', CB_MACHINE: 'mac' };
  assert.equal(cb(['iam', 'W7@macbook', 'ihop'], env).code, 0);

  const noBody = cb(['bug', 'ihop', 'claims page blank'], env);
  assert.equal(noBody.code, 1);
  assert.match(noBody.err, /-b "what happened/);

  const r = cb(['bug', 'ihop', 'claims page blank', '-b', 'Open /claims as payer.\nExpected list, got blank.'], env);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '#3 bug filed in ihop; told orch@shaltoot');
  const [t] = await sql`select project, type, status, priority, assignee, created_by from cb.tasks where id = 3`;
  assert.deepEqual({ ...t }, { project: 'ihop', type: 'bug', status: 'next', priority: 'P2', assignee: null, created_by: 'W7@macbook' });

  // a bug against Claude Board itself, from an ihop session: no orchestrator there, so its bound sessions hear it
  const b = cb(['bug', 'claude-board', 'cb brief hangs', '-b', 'cb brief took 30s', '-p', 'P1'], env);
  assert.equal(b.code, 0, b.err);
  assert.equal(b.out, '#4 bug filed in claude-board; told board-dev@shaltoot (no live orchestrator there)');
  const [x] = await sql`select project, priority from cb.tasks where id = 4`;
  assert.deepEqual({ ...x }, { project: 'claude-board', priority: 'P1' });

  // the printed names are exactly the sessions whose inbox gets the bug
  const box = async (m: string, p: string) => (await sql`select cb.inbox(${m}, ${p}, 0) as i`)[0].i.bugs.map((g: any) => g.id);
  assert.deepEqual(await box('pc', 'w2:p2'), [3]);
  assert.deepEqual(await box('mac', 'w1:p3'), []);
  assert.deepEqual(await box('pc', 'w3:pA'), [4]);
  assert.deepEqual(await box('mac', 'w1:p7'), [], 'the filer is not told about its own bug');

  // an alias works like everywhere else (release step: cb.project_alias('board', 'claude-board'))
  await sql`select cb.project_alias('board', 'claude-board')`;
  assert.match(cb(['bug', 'board', 'alias test', '-b', 'x'], env).out, /^#5 bug filed in claude-board/);

  const nobody = cb(['bug', 'newproj', 'x', '-b', 'y'], env);
  assert.equal(nobody.out, '#6 bug filed in newproj; no session works in newproj yet: it waits in Next');
  const own = cb(['bug', 'ihop', 'orch found one', '-b', 'z'], { CB_ACTOR: 'orch@shaltoot' });
  assert.equal(own.out, '#7 bug filed in ihop; you triage it: cb edit 7 --assignee <worker>');
});
