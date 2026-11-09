import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb, TEST_URL } from './helpers.ts';
import { COMMANDS, TOPIC_NAMES, OVERVIEW_TEXT, SNIPPET } from '../cli/help.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; }

function cb(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('node', ['cli/cb.ts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'W1@test', HERDR_PANE_ID: '', CB_MACHINE: 'mac',
      CLAUDE_CODE_MESSAGING_SOCKET: '', ...env },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test('every command in the cb.ts switch has a help entry and appears in cb help', () => {
  const src = readFileSync('cli/cb.ts', 'utf8');
  const cases = [...src.matchAll(/^\s*case '([a-z-]+)':/gm)].map((m) => m[1]);
  assert.ok(cases.length > 20, `found only ${cases.length} cases`);
  for (const c of cases) {
    assert.ok(COMMANDS[c], `cb ${c} has no entry in cli/help.ts GROUPS: add one`);
    assert.match(OVERVIEW_TEXT, new RegExp(`^  cb ${c}\\b`, 'm'), `cb help does not show cb ${c}`);
  }
});

test('cb help is the manual: overview, rules, topics, grouped commands with examples', () => {
  const r = cb(['help']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /FIRST: run  cb start/);
  for (const g of ['START A SESSION', 'TAKE WORK', 'REPORT', 'ASK AHMED', 'TALK TO SESSIONS', 'ORCHESTRATE']) assert.match(r.out, new RegExp(`^${g}$`, 'm'));
  assert.match(r.out, /e\.g\. cb done 42 /);
  for (const t of ['start', 'project', 'ask', 'orchestrate', 'huddle', 'relay', 'rules']) assert.ok(TOPIC_NAMES.includes(t), t);
  assert.equal(cb([]).out, r.out); // bare cb prints the same
});

test('cb help <topic> and cb help <command> print the detailed page; -h on a command too', () => {
  const ask = cb(['help', 'ask']);
  assert.equal(ask.code, 0, ask.err);
  assert.match(ask.out, /--free \(no options\): ONLY when no choice exists/);
  assert.match(ask.out, /Wrong .* --free/);
  const done = cb(['help', 'done']);
  assert.match(done.out, /^cb done <id> "<summary>"/); // (output is trimmed)
  assert.match(done.out, /More: cb help work/);
  assert.equal(cb(['ask', '-h']).out, ask.out);
  assert.match(cb(['help', 'project']).out, /cb iam orch@<machine> <slug>/);
});

test('cb help <unknown> exits 1 and lists the topics and commands', () => {
  const r = cb(['help', 'queue']);
  assert.equal(r.code, 1);
  assert.match(r.err, /no help for "queue"\. Topics: start, work, ask, huddle, relay, orchestrate, project, rules\. Commands: .*next/);
});

test('prompts/claude-md-snippet.md is the snippet cb help project prints', () => {
  assert.equal(readFileSync('prompts/claude-md-snippet.md', 'utf8').trim(), SNIPPET);
});

test('cb start, no herdr pane: act with --as / CB_ACTOR and poll', async () => {
  await db();
  const r = cb(['start'], { CB_ACTOR: '' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /no herdr pane/);
  assert.match(r.out, /--as <name>/);
});

test('cb start, unbound pane: says how to bind and lists the projects', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'ihop', title => 'a', status => 'next')`;
  await sql`select cb.task_add(project => 'tactiai', title => 'b')`;
  const r = cb(['start'], { CB_ACTOR: '', HERDR_PANE_ID: 'p7' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Project +NOT BOUND/);
  assert.match(r.out, /cb iam <name> <project>/);
  assert.match(r.out, /W1@mac/);
  assert.match(r.out, /^ +ihop +1 next/m);
  assert.match(r.out, /^ +tactiai/m);
  assert.doesNotMatch(r.out, /cb relay/); // one step at a time
});

test('cb start, bound without relay: run cb relay; then shows work and the queue head', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'ihop', title => 'held', status => 'in_progress', actor => 'W1@test')`;
  await sql`select cb.task_add(project => 'ihop', title => 'top of queue', status => 'next', priority => 'P1')`;
  await sql`select cb.iam('mac', 'p7', 'W1@test', 'ihop')`;
  const env = { CB_ACTOR: '', HERDR_PANE_ID: 'p7', CLAUDE_CODE_MESSAGING_SOCKET: `sock-${process.pid}` };
  const r = cb(['start'], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /You +W1@test/);
  assert.match(r.out, /Project +ihop/);
  assert.match(r.out, /Relay +OFF/);
  assert.match(r.out, /cb relay/);

  const lock = join(tmpdir(), `cb-relay-${createHash('sha1').update(env.CLAUDE_CODE_MESSAGING_SOCKET).digest('hex').slice(0, 12)}.pid`);
  writeFileSync(lock, String(process.pid)); // a live relay holds the lock
  try {
    const s = cb(['start'], env);
    assert.match(s.out, /Relay +on/);
    assert.match(s.out, /#1 \[in_progress\] P2 held/);
    assert.match(s.out, /#2 P1 top of queue/);
    assert.match(s.out, /continue #1/);
  } finally { rmSync(lock, { force: true }); }
  const [{ n }] = await sql`select count(*)::int as n from cb.tasks where status = 'next'`;
  assert.equal(n, 1); // read-only: nothing claimed
});

test('cb start, bound with nothing held: tells it to cb next', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'ihop', title => 'top', status => 'next')`;
  await sql`select cb.iam('mac', 'p7', 'W1@test', 'ihop')`;
  const r = cb(['start'], { CB_ACTOR: '', HERDR_PANE_ID: 'p7' });
  assert.match(r.out, /Relay +unavailable/);
  assert.match(r.out, /cb next/);
});

test('errors say what to run instead', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'ihop', title => 'x')`;
  assert.match(cb(['move', '1']).err, /^cb: missing arguments\. Usage: cb move <id> <status> \["<note>"\]\. Details: cb help move$/);
  assert.match(cb(['done', '77', 'x']).err, /task #77 not found.*cb mine/);
  assert.match(cb(['user', 'remove', 'x']).err, /cb user add <name>/);
  assert.match(cb(['huddle', 'show', '9']).err, /no huddle #9.*cb huddles/);
  assert.match(cb(['iam', 'W1@x', 'nope'], { HERDR_PANE_ID: 'p7' }).err, /unknown project "nope".*cb help project/);
  assert.match(cb(['frobnicate']).err, /unknown command "frobnicate"\. Commands: start, iam,.* Run: cb start/);
});

test('cb ask --free posts, and reminds that a choice needs options', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'ihop', title => 'x')`;
  const r = cb(['ask', 'ihop', 'What is the sandbox URL?', '--free']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Q1 posted/);
  assert.match(r.out, /cb withdraw Q1/);
  assert.doesNotMatch(cb(['ask', 'ihop', 'Merge?', '-o', 'Yes=x', '-o', 'No=y']).out, /withdraw/);
});
