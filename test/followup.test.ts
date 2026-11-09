// Follow-up questions (#472): a question that waits, dormant, for one answer to an earlier question.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; }

function cb(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('node', ['cli/cb.ts', ...args], {
    encoding: 'utf8', env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'W1@test', HERDR_PANE_ID: '', ...env },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

type Ask = { body: string; project?: string; options?: string[]; multi?: boolean; blocking?: boolean; task?: string;
  reply_to?: object; to?: string; parent?: string; if?: string; actor?: string };
const ask = async (sql: any, o: Ask) => Number((await sql`select cb.ask(project => ${o.project ?? 'demo'}, body => ${o.body},
  options => ${o.options ? sql.json(o.options) : null}, multi => ${o.multi ?? false}, blocking => ${o.blocking ?? false},
  task_id => ${o.task ?? null}, reply_to => ${o.reply_to ? sql.json(o.reply_to) : null}, actor => ${o.actor ?? 'W1'},
  to_user => ${o.to ?? null}, parent => ${o.parent ?? null}, if_answer => ${o.if ?? null}) as q`)[0].q);
const q = async (sql: any, id: number) => (await sql`select * from cb.questions where id = ${id}`)[0];
const status = async (sql: any, ...ids: number[]) => Promise.all(ids.map(async (id) => (await q(sql, id)).status));
const answer = (sql: any, id: number, a: string) => sql`select cb.answer(${String(id)}, ${a})`;
const yesNo = (sql: any, extra: Partial<Ask> = {}) => ask(sql, { body: 'Ship today?', options: ['Yes (Recommended)', 'No'], ...extra });

test('a follow-up waits dormant: not open, not waiting on Ahmed, not pending, no asked event', async () => {
  const sql = await db();
  const p = await yesNo(sql);
  const f = await ask(sql, { body: 'Which env first?', options: ['SIT', 'UAT'], parent: 'Q' + p, if: 'yes' });
  const row = await q(sql, f);
  assert.equal(row.status, 'dormant');
  assert.equal(Number(row.parent_id), p);
  assert.equal(row.if_answer, 'Yes (Recommended)', '--if matches case-insensitively and stores the parent\'s label');
  const [{ b }] = await sql`select cb.brief('demo') as b`;
  assert.deepEqual(b.open_questions.map((x: any) => Number(x.id)), [p]);
  assert.equal((await sql`select * from cb.answers_pending()`).length, 0);
  assert.equal((await sql`select * from cb.events where kind = 'asked' and question_id = ${f}`).length, 0);
  const [{ n }] = await sql`select count(*)::int n from cb.questions where status = 'open'`;
  assert.equal(n, 1);
  await assert.rejects(answer(sql, f, 'SIT'), /Q2 waits on Q1/, 'a dormant follow-up cannot be answered');
});

test('the Yes branch opens fresh with an asked event; the No branch is skipped', async () => {
  const sql = await db();
  const p = await yesNo(sql);
  const yes = await ask(sql, { body: 'Which env first?', options: ['SIT', 'UAT'], parent: String(p), if: 'Yes' });
  const no = await ask(sql, { body: 'What blocks it?', parent: String(p), if: 'NO' });
  const before = (await q(sql, yes)).created_at;
  await new Promise((r) => setTimeout(r, 20));
  await answer(sql, p, 'Yes — ship it after lunch'); // the dashboard sends the label without (Recommended), plus a note
  assert.deepEqual(await status(sql, p, yes, no), ['answered', 'open', 'withdrawn']);
  assert.ok((await q(sql, yes)).created_at > before, 'asked time is when it opened, so it sorts fresh');
  const [asked] = await sql`select actor from cb.events where kind = 'asked' and question_id = ${yes}`;
  assert.equal(asked.actor, 'W1', 'the asker asked it, not whoever answered the parent');
  const [skip] = await sql`select summary from cb.events where kind = 'withdrawn' and question_id = ${no}`;
  assert.match(skip.summary, /^skipped: Q1 answered Yes/);
  // editing the answer later does not re-route the branches (fired once, on the first answer)
  await answer(sql, p, 'No');
  assert.deepEqual(await status(sql, yes, no), ['open', 'withdrawn']);
});

test('multi-select: every chosen label opens its branch', async () => {
  const sql = await db();
  const p = await ask(sql, { body: 'Which suites?', options: ['Unit (Recommended)', 'DB', 'E2E'], multi: true });
  const [u, d, e] = [await ask(sql, { body: 'u?', parent: String(p), if: 'unit', options: ['a', 'b'] }),
    await ask(sql, { body: 'd?', parent: String(p), if: 'db', options: ['a', 'b'] }),
    await ask(sql, { body: 'e?', parent: String(p), if: 'e2e', options: ['a', 'b'] })];
  await answer(sql, p, 'Unit (Recommended); E2E — before Friday');
  assert.deepEqual(await status(sql, u, d, e), ['open', 'withdrawn', 'open']);
});

test('a free-text answer opens only the follow-ups without --if; --if on a --free parent is refused', async () => {
  const sql = await db();
  const free = await ask(sql, { body: 'Sandbox URL?' });
  await assert.rejects(ask(sql, { body: 'x', parent: String(free), if: 'yes' }), /Q1 has no options/);
  const any = await ask(sql, { body: 'Which tenant?', parent: String(free) });
  await answer(sql, free, 'https://sandbox.example');
  assert.deepEqual(await status(sql, any), ['open']);

  const p = await yesNo(sql);
  const always = await ask(sql, { body: 'Anything else?', parent: String(p) });
  const yes = await ask(sql, { body: 'Which env?', parent: String(p), if: 'Yes' });
  await answer(sql, p, 'Maybe next week'); // typed over the options: no label chosen
  assert.deepEqual(await status(sql, always, yes), ['open', 'withdrawn']);
});

test('withdrawing a parent withdraws its dormant follow-ups, down the chain; a dormant follow-up can be withdrawn', async () => {
  const sql = await db();
  const p = await yesNo(sql);
  const f = await ask(sql, { body: 'Which env?', options: ['SIT', 'UAT'], parent: String(p), if: 'Yes' });
  const g = await ask(sql, { body: 'Who deploys?', parent: String(f) });
  const other = await ask(sql, { body: 'unrelated', options: ['a', 'b'] });
  const h = await ask(sql, { body: 'h?', parent: String(other) });
  await sql`select cb.withdraw(${String(p)})`;
  assert.deepEqual(await status(sql, p, f, g, other, h), ['withdrawn', 'withdrawn', 'withdrawn', 'open', 'dormant']);
  await sql`select cb.withdraw(${String(h)})`;
  assert.equal((await q(sql, h)).status, 'withdrawn');
});

test('ask refuses a bad follow-up: unknown parent, other project, closed parent, unknown label, --if alone', async () => {
  const sql = await db();
  const p = await yesNo(sql);
  await assert.rejects(ask(sql, { body: 'x', parent: '99' }), /question Q99 not found/);
  await assert.rejects(ask(sql, { body: 'x', parent: String(p), project: 'other' }), /Q1 is in demo/);
  await assert.rejects(ask(sql, { body: 'x', parent: String(p), if: 'Maybe' }), /"Maybe" is not one of Q1's options: Yes \(Recommended\), No/);
  await assert.rejects(ask(sql, { body: 'x', if: 'Yes' }), /--if needs --after/);
  await answer(sql, p, 'No');
  await assert.rejects(ask(sql, { body: 'x', parent: String(p) }), /Q1 is already answered/);
  assert.equal((await sql`select count(*)::int n from cb.questions`)[0].n, 1);
});

test('a chain of two: each answer fires the next; a skipped link skips the rest', async () => {
  const sql = await db();
  const p = await yesNo(sql);
  const f = await ask(sql, { body: 'Which env?', options: ['SIT', 'UAT'], parent: String(p), if: 'Yes' });
  const g = await ask(sql, { body: 'Smoke test first?', options: ['Yes', 'No'], parent: String(f), if: 'UAT' });
  await answer(sql, p, 'Yes');
  assert.deepEqual(await status(sql, f, g), ['open', 'dormant']);
  await answer(sql, f, 'UAT');
  assert.deepEqual(await status(sql, g), ['open']);

  const p2 = await yesNo(sql);
  const f2 = await ask(sql, { body: 'Which env?', options: ['SIT', 'UAT'], parent: String(p2), if: 'Yes' });
  const g2 = await ask(sql, { body: 'Who deploys?', parent: String(f2) });
  await answer(sql, p2, 'No');
  assert.deepEqual(await status(sql, f2, g2), ['withdrawn', 'withdrawn']);
  const skipped = await sql`select summary from cb.events where kind = 'withdrawn' and question_id in (${f2}, ${g2}) order by question_id`;
  assert.deepEqual(skipped.map((e: any) => e.summary), [`skipped: Q${p2} answered No`, `skipped: Q${p2} answered No`]);
});

test('a follow-up inherits task, reply_to and recipient; --blocking takes the task only when it opens', async () => {
  const sql = await db();
  await sql`select cb.user_add('omar', 'Omar'), cb.ensure_project('demo'), cb.user_project_add('omar', 'demo', 'ahmed')`;
  await sql`select cb.task_add(project => 'demo', title => 'Deploy', status => 'in_progress', actor => 'W1')`;
  const p = await yesNo(sql, { task: '1', reply_to: { machine: 'mac', pane: 'p3' }, to: 'omar' });
  const f = await ask(sql, { body: 'Which env?', options: ['SIT', 'UAT'], parent: String(p), if: 'Yes', blocking: true });
  const row = await q(sql, f);
  assert.deepEqual([Number(row.task_id), row.reply_to, row.assigned_to], [1, { machine: 'mac', pane: 'p3' }, 'omar']);
  let [t] = await sql`select status, blocked_on from cb.tasks where id = 1`;
  assert.deepEqual([t.status, t.blocked_on], ['in_progress', null], 'a dormant follow-up holds nothing');
  await answer(sql, p, 'Yes');
  [t] = await sql`select status, blocked_on from cb.tasks where id = 1`;
  assert.deepEqual([t.status, Number(t.blocked_on)], ['blocked', f]);
  await sql`select cb.answer_delivered(${String(p)}, 'W1')`;
  [t] = await sql`select status from cb.tasks where id = 1`;
  assert.equal(t.status, 'blocked', 'the parent\'s delivery does not release the follow-up\'s hold');
  await answer(sql, f, 'SIT');
  await sql`select cb.answer_delivered(${String(f)}, 'W1')`;
  [t] = await sql`select status from cb.tasks where id = 1`;
  assert.equal(t.status, 'in_progress');
});

test('a blocking parent hands its task to a blocking follow-up', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'Deploy', status => 'in_progress', actor => 'W1')`;
  const p = await yesNo(sql, { task: '1', blocking: true });
  const f = await ask(sql, { body: 'Which env?', options: ['SIT', 'UAT'], parent: String(p), if: 'Yes', blocking: true });
  await answer(sql, p, 'Yes');
  await sql`select cb.answer_delivered(${String(p)}, 'W1')`;
  const [t] = await sql`select status, blocked_on from cb.tasks where id = 1`;
  assert.deepEqual([t.status, Number(t.blocked_on)], ['blocked', f]);
});

test('the follow-up\'s answer is its own delivery, quoting the parent question and answer', async () => {
  const sql = await db();
  await sql`select cb.iam('mac', 'p3', 'W1')`;
  const p = await yesNo(sql, { reply_to: { machine: 'mac', pane: 'p3' } });
  const f = await ask(sql, { body: 'Which env first?', options: ['SIT', 'UAT'], parent: String(p), if: 'Yes', reply_to: { machine: 'mac', pane: 'p3' } });
  await answer(sql, p, 'Yes');
  await sql`select cb.answer_delivered(${String(p)}, 'W1')`;
  await answer(sql, f, 'UAT');
  const [{ i }] = await sql`select cb.inbox('mac', 'p3', 0) as i`;
  assert.deepEqual(i.answers.map((a: any) => [Number(a.id), a.answer, Number(a.parent_id), a.parent_body, a.parent_answer]),
    [[f, 'UAT', p, 'Ship today?', 'Yes']]);
  const r = cb(['pending', 'demo']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Q2 → W1[\s\S]*follow-up to Q1 \(answered Yes\): Ship today\?[\s\S]*asked: Which env first\?[\s\S]*answer: UAT/);
});

// A stand-in for Claude Code's inbox (same as relay.test.ts).
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

test('the relay pushes a follow-up\'s answer with the parent quoted', { timeout: 30_000 }, async () => {
  const sql = await db();
  const path = process.platform === 'win32' ? String.raw`\\.\pipe\cb-followup-test-` + process.pid : join(tmpdir(), `cb-followup-${process.pid}.sock`);
  const to = { machine: 'testbox', pane: 'p9' };
  const p = await yesNo(sql, { reply_to: to, actor: 'W9' });
  const f = await ask(sql, { body: 'Which env first?', options: ['SIT', 'UAT'], parent: String(p), if: 'Yes', reply_to: to, actor: 'W9' });
  await answer(sql, p, 'Yes');
  await sql`select cb.answer_delivered(${String(p)}, 'W9')`;
  const inbox = fakeInbox(path, 'tok'); // after the setup: a listening server left open would keep the run alive
  fs.writeFileSync(join(tmpdir(), `cb-relay-${createHash('sha1').update(path).digest('hex').slice(0, 12)}.pid`), '');
  const relay = spawn('node', ['cli/relay.ts', '--child'], {
    stdio: 'ignore',
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_MACHINE: 'testbox', HERDR_PANE_ID: 'p9',
           CLAUDE_CODE_MESSAGING_SOCKET: path, CLAUDE_CODE_MESSAGING_TOKEN: 'tok' },
  });
  const exited = new Promise((r) => relay.on('exit', r));
  try {
    await new Promise((r) => setTimeout(r, 1500));
    await answer(sql, f, 'UAT');
    for (let i = 0; i < 50 && !inbox.got.length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(inbox.got.length, 1);
    assert.match(inbox.got[0].message.content, /answered Q2: UAT\n  Follow-up to Q1 \(answered Yes\): Ship today\?\n  You asked: Which env first\?/);
  } finally {
    relay.kill();
    await exited;
    await inbox.close();
  }
});

test('cb ask --after/--if round-trip; --if without --after is refused', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  assert.equal(cb(['ask', 'demo', 'Ship today?', '-o', 'Yes', '-o', 'No']).code, 0);
  const r = cb(['ask', 'demo', 'Which env first?', '-o', 'SIT', '-o', 'UAT', '--after', 'Q1', '--if', 'yes']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Q2 posted as a follow-up to Q1: it opens only if Q1 is answered "Yes", else it is skipped/);
  const n = cb(['ask', 'demo', 'Anything else?', '--free', '--after', '1']);
  assert.match(n.out, /^Q3 posted as a follow-up to Q1: it opens once Q1 is answered — keep working/);
  const row = await q(sql, 2);
  assert.deepEqual([row.status, Number(row.parent_id), row.if_answer], ['dormant', 1, 'Yes']);
  const bad = cb(['ask', 'demo', 'x?', '-o', 'a', '-o', 'b', '--if', 'Yes']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /--if needs --after/);
  const label = cb(['ask', 'demo', 'x?', '-o', 'a', '-o', 'b', '--after', 'Q1', '--if', 'Maybe']);
  assert.match(label.err, /"Maybe" is not one of Q1's options: Yes, No/);
});
