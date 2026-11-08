import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; }

test('iam binds a pane to an actor; the CLI acts as it', async () => {
  const sql = await db();
  const env = { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: '', HERDR_PANE_ID: 'w1:p3', CB_MACHINE: 'MacBook' };
  const run = (args: string[]) => spawnSync('node', ['cli/cb.ts', ...args], { encoding: 'utf8', env });
  assert.equal(run(['iam', 'W1@macbook']).status, 0);
  run(['add', 'demo', 'mine now', '-s', 'in_progress']);
  const [t] = await sql`select assignee, created_by from cb.tasks`;
  assert.deepEqual({ ...t }, { assignee: 'W1@macbook', created_by: 'W1@macbook' });
  const [s] = await sql`select machine, pane, actor from cb.sessions`;
  assert.deepEqual({ ...s }, { machine: 'macbook', pane: 'w1:p3', actor: 'W1@macbook' });
});

test('inbox: my answered questions and others\' changes to my tasks', async () => {
  const sql = await db();
  await sql`select cb.iam('macbook', 'w1:p3', 'W1')`;
  await sql`select cb.task_add(project => 'demo', title => 'T', status => 'in_progress', actor => 'W1')`;
  await sql`select cb.ask(project => 'demo', body => 'which?', task_id => '1', reply_to => ${sql.json({ machine: 'MacBook', pane: 'w1:p3' })}, actor => 'W1')`;
  await sql`select cb.ask(project => 'demo', body => 'not mine', reply_to => ${sql.json({ machine: 'macbook', pane: 'w2:p1' })})`;
  const [{ start }] = await sql`select coalesce(max(id), 0) as start from cb.events`;
  await sql`select cb.answer('1', 'A')`;
  await sql`select cb.answer('2', 'B')`;
  await sql`select cb.task_move('1', 'review', 'Ahmed wants eyes', 'ahmed')`;
  await sql`select cb.log('demo', 'self note', '1', '{}', 'W1')`;
  const [{ i }] = await sql`select cb.inbox('macbook', 'w1:p3', ${start}) as i`;
  assert.equal(i.actor, 'W1');
  assert.deepEqual(i.answers.map((a: any) => [Number(a.id), a.answer]), [[1, 'A']]);
  assert.deepEqual(i.events.map((e: any) => [e.kind, e.summary]), [['moved', 'Ahmed wants eyes']]);
  assert.ok(i.last_event > start);
});

// A stand-in for Claude Code's inbox: checks the auth line, collects messages.
function fakeInbox(path: string, token: string) {
  const got: any[] = [];
  const server = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop()!;
      if (lines.length && !got.length && JSON.parse(lines[0]).token !== token) return c.destroy();
      for (const l of lines.slice(1)) got.push(JSON.parse(l));
    });
  });
  server.listen(path);
  return { got, close: () => new Promise((r) => server.close(r)) };
}

test('relay pushes an answer into its session and marks it delivered', { timeout: 30_000 }, async () => {
  const sql = await db();
  const path = process.platform === 'win32' ? String.raw`\\.\pipe\cb-relay-test-` + process.pid : join(tmpdir(), `cb-relay-${process.pid}.sock`);
  const inbox = fakeInbox(path, 'tok');
  await sql`select cb.ask(project => 'demo', body => 'Rotate keys?', reply_to => ${sql.json({ machine: 'testbox', pane: 'p9' })}, actor => 'W9')`;
  const relay = spawn('node', ['cli/relay.ts', '--child'], {
    stdio: 'ignore',
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_MACHINE: 'testbox', HERDR_PANE_ID: 'p9',
           CLAUDE_CODE_MESSAGING_SOCKET: path, CLAUDE_CODE_MESSAGING_TOKEN: 'tok' },
  });
  const exited = new Promise((r) => relay.on('exit', r));
  try {
    await new Promise((r) => setTimeout(r, 1500)); // relay is listening
    await sql`select cb.answer('1', 'Rotate now')`;
    for (let i = 0; i < 50 && !inbox.got.length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(inbox.got.length, 1);
    assert.equal(inbox.got[0].type, 'user');
    assert.match(inbox.got[0].message.content, /Q1.*Rotate now/s);
    // marked delivered only after the inbox took the message
    let q: any;
    for (let i = 0; i < 30 && q?.status !== 'delivered'; i++) {
      [q] = await sql`select status from cb.questions`;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(q.status, 'delivered');
  } finally {
    await inbox.close(); // session gone → relay exits on its own
    await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
    assert.notEqual(relay.exitCode, null, 'relay should exit when its session inbox disappears');
  }
});
