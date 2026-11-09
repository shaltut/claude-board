import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb, TEST_URL } from './helpers.ts';

const clients: any[] = [];
after(() => Promise.all(clients.map((c) => c.end())));
async function db() { const s = await freshDb(); clients.push(s); return s; }

const dir = mkdtempSync(join(tmpdir(), 'cb-tick-'));
let n = 0;
/** A node script standing in for gh: answers every graphql query with these PRs (by number), or fails
 *  (always with prs = null, or only for the repo named `fail`). */
function fakeGh(prs: Record<string, any> | null, fail?: string) {
  const f = join(dir, `gh${++n}.mjs`);
  writeFileSync(f, prs
    ? `const prs = ${JSON.stringify(prs)};
       const q = process.argv.find((a) => a.startsWith('query='));
       if (${JSON.stringify(fail ?? null)} && q.includes('name: "' + ${JSON.stringify(fail ?? null)} + '"')) { process.stderr.write('GraphQL: Could not resolve to a Repository\\n'); process.exit(1); }
       const repo = {}; for (const [, n] of q.matchAll(/p(\\d+): *pullRequest/g)) repo['p' + n] = prs[n] ?? null;
       process.stdout.write(JSON.stringify({ data: { repository: repo } }));`
    : `process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\\n'); process.exit(4);`);
  return { CB_GH: f, CB_GH_CACHE: join(dir, `cache${n}.json`) };
}

function cb(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('node', ['cli/cb.ts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_ACTOR: 'orch@test', HERDR_PANE_ID: '', ...fakeGh({}), ...env },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const ago = (sql: any, where: any, interval: string) => sql`update cb.events set at = now() - ${interval}::interval where ${where}`;
const URL = 'https://github.com/acme/app/pull/';

test('tick: nothing due prints nothing', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'later', status => 'backlog')`;
  const r = cb(['tick', 'demo']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '');
});

test('tick: answers not acted on name who acts, with one command', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  await sql`select cb.iam('macbook', 'w3:p1', 'W3@macbook', 'demo')`;
  await sql`select cb.ask(project => 'demo', body => 'Which DB?', reply_to => ${sql.json({ machine: 'macbook', pane: 'w3:p1' })}, actor => 'orch@test')`;
  await sql`select cb.ask(project => 'demo', body => 'Ship it?', options => '["Yes","No"]', actor => 'orch@test')`;
  await sql`select cb.answer('1', 'Use the it''s-fine DB')`;
  await sql`select cb.answer('2', 'Yes')`;
  const r = cb(['tick', 'demo']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^ANSWERS NOT ACTED ON/);
  // addressed to W3's pane: W3 acts; the answer travels in a single-quoted arg (no shell expansion)
  assert.match(r.out, /Q1 answered \S+ ago, W3@macbook acts → cb tell W3@macbook 'Q1: Use the it''s-fine DB' && cb delivered 1 W3@macbook/);
  assert.match(r.out, /asked: Which DB\?/);
  // the orchestrator's own question: it acts, then marks it delivered
  assert.match(r.out, /Q2 answered \S+ ago, orch@test acts → cb delivered 2\n\s+asked: Ship it\? · answer: Yes/);
});

test('tick: my open questions with ages, flagging ones sent without options', async () => {
  const sql = await db();
  await sql`select cb.ask(project => 'demo', body => 'Free one', actor => 'orch@test')`;
  await sql`select cb.ask(project => 'demo', body => 'With options', options => '["A","B"]', actor => 'orch@test')`;
  await sql`select cb.ask(project => 'demo', body => 'Not mine', actor => 'W1@test')`;
  const r = cb(['tick', 'demo']);
  assert.match(r.out, /YOUR OPEN QUESTIONS\n\s+Q1 open \S+, ahmed: Free one ⚠ no options → cb withdraw 1/);
  assert.match(r.out, /Q2 open \S+, ahmed: With options$/m);
  assert.doesNotMatch(r.out, /Not mine/);
});

test('tick: stuck work (silent holder, long block, review with no reviewer, someone else working it)', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'quiet work', status => 'in_progress', assignee => 'W7@m', actor => 'W7@m')`;
  await sql`select cb.task_add(project => 'demo', title => 'busy work', status => 'in_progress', assignee => 'W8@m', actor => 'W8@m')`;
  await sql`select cb.task_add(project => 'demo', title => 'stuck', status => 'in_progress', assignee => 'W9@m', actor => 'W9@m')`;
  await sql`select cb.task_move('3', 'blocked', 'waiting for the DB lock', 'W9@m')`;
  await sql`select cb.task_add(project => 'demo', title => 'parser fix', status => 'review', assignee => 'W2@m', actor => 'W2@m')`;
  await sql`select cb.task_add(project => 'demo', title => 'reviewed fix', status => 'review', assignee => 'W2@m', actor => 'W2@m')`;
  await sql`select cb.task_add(project => 'demo', title => 'Cross-review #5 (W2)', status => 'next', labels => '["review"]', actor => 'orch@test')`;
  await sql`select cb.task_add(project => 'demo', title => 'W4 job', status => 'in_progress', assignee => 'W4@m', actor => 'orch@test')`;
  await sql`select cb.log('demo', 'I am on it', '7', '{}', 'W3@m')`;
  await sql`select cb.task_add(project => 'demo', title => 'PO questions for Omar', status => 'review', assignee => 'orch@test', actor => 'orch@test')`;
  await ago(sql, sql`actor in ('W7@m', 'W9@m')`, '2 hours');
  const r = cb(['tick', 'demo']);
  assert.match(r.out, /STUCK/);
  assert.match(r.out, /#1 W7@m silent 2h \(in progress\) → cb tell W7@m '#1 quiet work: still on it\?/);
  assert.doesNotMatch(r.out, /#2 W8@m/);
  assert.match(r.out, /#3 blocked 2h, W9@m: waiting for the DB lock → cb tell W9@m/);
  assert.match(r.out, /#4 in review, no reviewer task \(W2@m\) → cb add demo 'Review #4 \(W2@m\): parser fix' -s next -l review/);
  assert.doesNotMatch(r.out, /#5 in review/);
  assert.doesNotMatch(r.out, /#8 in review/); // the orchestrator's: waiting on a person, not a code review
  assert.match(r.out, /#7 assigned W4@m, W3@m works it → cb edit 7 --assignee W3@m/);
  // W9 is silent too, but its task is blocked, not in progress
  assert.doesNotMatch(r.out, /#3 W9@m silent/);
});

test('tick: idle live sessions get the unassigned Next task matching their tags', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  await sql`select cb.iam('macbook', 'p1', 'W5@macbook', 'demo')`;
  await sql`select cb.iam('macbook', 'p2', 'W6@macbook', 'demo')`;
  await sql`select cb.iam('macbook', 'p3', 'W7@macbook', 'demo')`;
  await sql`select cb.iam('shaltoot', 'p0', 'orch@test', 'demo')`;
  await sql`select cb.task_add(project => 'demo', title => 'old ocr', status => 'done', labels => '["ocr"]', assignee => 'W5@macbook')`;
  await sql`select cb.task_add(project => 'demo', title => 'busy', status => 'in_progress', assignee => 'W7@macbook')`;
  await sql`select cb.task_add(project => 'demo', title => 'money first', status => 'next', labels => '["money"]')`;
  await sql`select cb.task_add(project => 'demo', title => 'ocr second', status => 'next', labels => '["ocr"]')`;
  const r = cb(['tick', 'demo']);
  assert.match(r.out, /IDLE\n/);
  assert.match(r.out, /W5@macbook idle → cb tell W5@macbook 'take #4 ocr second'/);
  assert.match(r.out, /W6@macbook idle → cb tell W6@macbook 'take #3 money first'/);
  assert.doesNotMatch(r.out, /W7@macbook idle|orch@test idle/);
  // more idle sessions than free tasks: the rest share one line asking for work
  await sql`select cb.iam('macbook', 'p4', 'W8@macbook', 'demo')`;
  await sql`select cb.iam('macbook', 'p5', 'W9@macbook', 'demo')`;
  assert.match(cb(['tick', 'demo']).out, /\n\s+W8@macbook, W9@macbook idle, nothing unassigned in Next → cb add demo '<title>' -s next$/);
});

test('tick: quiet huddles and held locks', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  await sql`select cb.iam('macbook', 'p1', 'W1@m', 'demo')`;
  await sql`select cb.huddle_open(topic => 'Hijri dates', members => '["W1@m"]', actor => 'orch@test', project => 'demo')`;
  await sql`select cb.huddle_open(topic => 'fresh talk', actor => 'orch@test', project => 'demo')`;
  await ago(sql, sql`(data ->> 'huddle')::int = 1`, '25 minutes');
  await sql`select cb.lock_take('db', 'W8@m')`;
  await sql`select cb.lock_take('db', 'W3@m')`;
  await sql`select cb.log('demo', 'running DB suites', null, '{}', 'W8@m')`; // the holder is alive
  const r = cb(['tick', 'demo']);
  assert.match(r.out, /HUDDLES\n\s+huddle #1 'Hijri dates' quiet 25m → cb huddle close 1 '<outcome>'/);
  assert.doesNotMatch(r.out, /fresh talk/);
  assert.match(r.out, /LOCKS\n\s+lock db: W8@m holds it \S+, queue W3@m → cb tell W8@m 'release lock db when done: 1 waiting'/);
});

test('locks: take queues, release hands over and tells the next holder', async () => {
  const sql = await db();
  let r = cb(['lock', 'take', 'DB'], { CB_ACTOR: 'W8@m' });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'you hold lock db');
  r = cb(['lock', 'take', 'db'], { CB_ACTOR: 'W3@m' });
  assert.match(r.out, /^lock db is held by W8@m \(\S+\); you are #1 in the queue/);
  assert.equal(cb(['lock', 'take', 'db'], { CB_ACTOR: 'W3@m' }).code, 0); // idempotent
  r = cb(['lock', 'queue', 'db']);
  assert.match(r.out, /^lock db: W8@m holds it \S+, queue W3@m$/);
  assert.match(cb(['lock', 'release', 'db'], { CB_ACTOR: 'W5@m' }).err, /W5@m does not hold or wait for lock db/);
  r = cb(['lock', 'release', 'db'], { CB_ACTOR: 'W8@m' });
  assert.equal(r.out, 'released lock db; W3@m holds it now');
  const [m] = await sql`select summary, data from cb.events where kind = 'message'`;
  assert.equal(m.data.to, 'W3@m');
  assert.match(m.summary, /lock db is yours/);
  r = cb(['lock', 'release', 'db'], { CB_ACTOR: 'W3@m' });
  assert.equal(r.out, 'released lock db; it is free');
  assert.equal(cb(['lock', 'queue']).out, 'no locks held');
});

test('locks: --force releases a dead holder\'s lock (any session, logged); tick offers it for a silent holder', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('demo')`;
  await sql`select cb.lock_take('db', 'W8@m')`;
  await sql`select cb.lock_take('db', 'W3@m')`;
  await sql`select cb.log('demo', 'starting suites', null, '{}', 'W8@m')`;
  await ago(sql, sql`actor = 'W8@m'`, '45 minutes');
  await sql`update cb.locks set held_at = now() - interval '50 minutes' where held_at is not null`;
  let r = cb(['tick', 'demo']);
  assert.match(r.out, /LOCKS\n\s+lock db: W8@m holds it \S+, queue W3@m, holder silent 45m → cb lock release db --force$/m);
  r = cb(['lock', 'release', 'db', '--force'], { CB_ACTOR: 'orch@test' });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'released lock db; W3@m holds it now');
  const ev = await sql`select actor, kind, summary, data from cb.events where kind in ('note', 'message') and actor = 'orch@test' order by id`;
  assert.ok(ev.some((e: any) => e.kind === 'note' && /force-released lock db from W8@m/.test(e.summary)), JSON.stringify(ev));
  assert.ok(ev.some((e: any) => e.kind === 'message' && e.data.to === 'W8@m' && /force-released/.test(e.summary)));
  assert.ok(ev.some((e: any) => e.kind === 'message' && e.data.to === 'W3@m' && /lock db is yours/.test(e.summary)));
  assert.match(cb(['lock', 'release', 'nope', '--force']).err, /lock nope is not held/);
});

async function seedReviews(sql: any) {
  // #1 implementation (W7) → PR 10, reviewed GO at the head → MERGE
  await sql`select cb.task_add(project => 'demo', title => 'fix A', status => 'in_progress', assignee => 'W7@m', actor => 'W7@m')`;
  await sql`select cb.task_done('1', 'done', ${sql.json({ pr: URL + '10', commit: 'aaa1111' })}, 'W7@m')`;
  await sql`select cb.task_add(project => 'demo', title => 'Cross-review #10 (W7, #1)', status => 'in_progress', labels => '["review"]', assignee => 'W5@m', actor => 'W5@m')`;
  await sql`select cb.task_done('2', 'GO @ aaa1111: holds', ${sql.json({ pr: URL + '10', commit: 'aaa1111' })}, 'W5@m')`;
  // PR 11: a GO, then the head moved
  await sql`select cb.task_add(project => 'demo', title => 'Cross-review #11', status => 'in_progress', labels => '["review"]', assignee => 'W5@m', actor => 'W5@m')`;
  await sql`select cb.task_done('3', '#11 GO (bbb2222): fine', ${sql.json({ pr: URL + '11', commit: 'bbb2222' })}, 'W5@m')`;
  // PR 12: GO but conflicting; W4 wrote the change
  await sql`select cb.task_add(project => 'demo', title => 'fix C', status => 'in_progress', assignee => 'W4@m', actor => 'W4@m')`;
  await sql`select cb.task_done('4', 'done', ${sql.json({ pr: URL + '12' })}, 'W4@m')`;
  await sql`select cb.task_add(project => 'demo', title => 'Review #12', status => 'in_progress', labels => '["review"]', assignee => 'W3@m', actor => 'W3@m')`;
  await sql`select cb.task_done('5', 'GO on the change; CONFLICTS with develop', ${sql.json({ pr: URL + '12', commit: 'ccc3333' })}, 'W3@m')`;
  // PR 13: first GO, later NO-GO: not ready
  await sql`select cb.task_add(project => 'demo', title => 'Review #13', status => 'in_progress', labels => '["review"]', assignee => 'W3@m', actor => 'W3@m')`;
  await sql`select cb.task_done('6', 'GO', ${sql.json({ pr: URL + '13', commit: 'ddd4444' })}, 'W3@m')`;
  await sql`select cb.task_add(project => 'demo', title => 'Delta review #13', status => 'in_progress', labels => '["review"]', assignee => 'W3@m', actor => 'W3@m')`;
  await sql`select cb.task_done('7', 'NO-GO: breaks totals', ${sql.json({ pr: URL + '13', commit: 'eee5555' })}, 'W3@m')`;
  // #8 still in progress but its PR merged; #9 done with an open PR and nobody reviewing it
  await sql`select cb.task_add(project => 'demo', title => 'fix D', status => 'in_progress', assignee => 'W6@m', links => ${sql.json({ pr: URL + '14' })}, actor => 'W6@m')`;
  await sql`select cb.task_add(project => 'demo', title => 'fix E', status => 'in_progress', assignee => 'W2@m', actor => 'W2@m')`;
  await sql`select cb.task_done('9', 'done', ${sql.json({ pr: '#15' })}, 'W2@m')`;
}

const PRS = {
  10: { state: 'OPEN', headRefOid: 'aaa1111' + '0'.repeat(33), mergeable: 'MERGEABLE' },
  11: { state: 'OPEN', headRefOid: 'fff9999' + '0'.repeat(33), mergeable: 'UNKNOWN' },
  12: { state: 'OPEN', headRefOid: 'ccc3333' + '0'.repeat(33), mergeable: 'CONFLICTING' },
  13: { state: 'OPEN', headRefOid: 'eee5555' + '0'.repeat(33), mergeable: 'MERGEABLE' },
  14: { state: 'MERGED', headRefOid: '1'.repeat(40), mergeable: 'UNKNOWN' },
  15: { state: 'OPEN', headRefOid: '2'.repeat(40), mergeable: 'MERGEABLE' },
};
// every open PR's mergeability known: all of it is cacheable (an open PR's UNKNOWN never is)
const KNOWN = { ...PRS, 11: { ...PRS[11], mergeable: 'MERGEABLE' } };

test('tick: ready to merge compares the PR head with the reviewed commit; board vs GitHub', async () => {
  const sql = await db();
  await seedReviews(sql);
  const r = cb(['tick', 'demo'], { ...fakeGh(PRS), GITHUB_REPO_DEMO: 'acme/app' });
  assert.equal(r.code, 0, r.err);
  // READY holds merge commands only, each with what the reviewer wrote; the merge only goes through if the head is still the reviewed commit
  const ready = r.out.split(/\n(?=\S)/).find((s) => s.startsWith('READY TO MERGE'))!;
  assert.equal(ready.split('\n').length, 2, ready);
  assert.match(ready, /#10 GO@aaa1111 = head \(review #2\): "GO @ aaa1111: holds" → gh pr merge 10 -R acme\/app --match-head-commit aaa11110{33}$/m);
  // a moved head or a conflict is work, not a merge: STUCK
  const stuck = r.out.split(/\n(?=\S)/).find((s) => s.startsWith('STUCK'))!;
  assert.match(stuck, /#11 GO@bbb2222, HEAD MOVED to fff9999000 → cb add demo 'Delta review #11 bbb2222\.\.fff9999000' -s next -l review --link pr=https:\/\/github\.com\/acme\/app\/pull\/11/);
  assert.match(stuck, /#12 GO@ccc3333 CONFLICTING → cb tell W4@m '#12 conflicts with its base: rebase it, then ask for a delta review'/);
  assert.doesNotMatch(r.out, /#13 GO/);
  assert.match(r.out, /BOARD VS GITHUB\n\s+#8 in_progress but PR #14 merged → cb done 8 'PR #14 merged'/);
  // the bare "#15" link resolves through GITHUB_REPO_DEMO
  assert.match(r.out, /#9 done, PR #15 open, no reviewer task \(W2@m\) → cb add demo 'Review #15 \(W2@m, #9\): fix E' -s next -l review --link 'pr=#15'/);
  assert.doesNotMatch(r.out, /skipped/);
  // the order is the urgency order
  assert.ok(r.out.indexOf('READY TO MERGE') < r.out.indexOf('STUCK') && r.out.indexOf('STUCK') < r.out.indexOf('BOARD VS GITHUB'));

  const j = JSON.parse(cb(['tick', 'demo', '--json'], { ...fakeGh(PRS), GITHUB_REPO_DEMO: 'acme/app' }).out);
  const merge = j.items.find((i: any) => i.section === 'ready');
  assert.equal(merge.cmd, `gh pr merge 10 -R acme/app --match-head-commit aaa1111${'0'.repeat(33)}`);
  assert.deepEqual(j.github.skipped, []);
});

test('tick: a GO with a condition after it is not a bare merge', async () => {
  const sql = await db();
  const head = (c: string) => c + '0'.repeat(40 - c.length);
  const review = async (pr: number, summary: string, commit: string) => {
    const [{ id }] = await sql`select cb.task_add(project => 'demo', title => ${'Review #' + pr}, status => 'in_progress', labels => '["review"]', assignee => 'W5@m', actor => 'W5@m') as id`;
    await sql`select cb.task_done(${String(id)}, ${summary}, ${sql.json({ pr: URL + pr, commit })}, 'W5@m')`;
  };
  await review(30, 'GO @ aaa1111: tsc 0; merge after the DB suites run', 'aaa1111');
  await review(31, 'R3 GO @bbb2222 but NOT merged: open owner Q36 (bare figures glue). Merge on the owner answer.', 'bbb2222');
  await review(32, 'GO: tsc rc=0; conditions: owner-only records', 'ccc3333');
  await review(33, 'Owner Q29 answered "merge now"; merging on the creator GO + W5 GO ddd4444', 'ddd4444'); // the Q is before the GO
  const prs = Object.fromEntries([[30, 'aaa1111'], [31, 'bbb2222'], [32, 'ccc3333'], [33, 'ddd4444']]
    .map(([n, c]) => [n, { state: 'OPEN', headRefOid: head(c as string), mergeable: 'MERGEABLE' }]));
  const r = cb(['tick', 'demo'], fakeGh(prs));
  assert.equal(r.code, 0, r.err);
  const group = (t: string) => r.out.split(/\n(?=\S)/).find((s) => s.startsWith(t)) ?? '';
  const cond = group('GO WITH CONDITIONS');
  assert.match(cond, /#30 GO \(conditional\): "GO @ aaa1111: tsc 0; merge after the DB suites run" → check, then gh pr merge 30 -R acme\/app --match-head-commit aaa11110{33}/);
  assert.match(cond, /#31 GO \(conditional\): "R3 GO @bbb2222 but NOT merged: open owner Q36 \(bare figures glue\)\. Me…" → check, then gh pr merge 31 /);
  assert.match(cond, /#32 GO \(conditional\)/);
  assert.doesNotMatch(cond, /#33/);
  const ready = group('READY TO MERGE');
  assert.match(ready, /#33 GO@ddd4444 = head \(review #4\): "Owner Q29 answered/);
  assert.doesNotMatch(ready, /#3[012]/);
  assert.ok(r.out.indexOf('READY TO MERGE') < r.out.indexOf('GO WITH CONDITIONS'));
});

test('tick: UNKNOWN mergeability is never a bare merge: re-asked once in the run, else "check first" (#2651)', async () => {
  const sql = await db();
  for (const pr of [40, 41]) {
    const [{ id }] = await sql`select cb.task_add(project => 'demo', title => ${'Review #' + pr}, status => 'in_progress', labels => '["review"]', assignee => 'W5@m', actor => 'W5@m') as id`;
    await sql`select cb.task_done(${String(id)}, 'GO: fine', ${sql.json({ pr: URL + pr, commit: 'aaa1111' })}, 'W5@m')`;
  }
  // GitHub answers UNKNOWN the first time (it computes mergeability lazily); asked again, #40 is CONFLICTING, #41 still UNKNOWN
  const f = join(dir, `gh${++n}.mjs`), count = join(dir, `count${n}`);
  writeFileSync(f, `import fs from 'node:fs';
    const calls = (fs.existsSync(${JSON.stringify(count)}) ? +fs.readFileSync(${JSON.stringify(count)}, 'utf8') : 0) + 1;
    fs.writeFileSync(${JSON.stringify(count)}, String(calls));
    const q = process.argv.find((a) => a.startsWith('query='));
    const repo = {};
    for (const [, n] of q.matchAll(/p(\\d+): *pullRequest/g))
      repo['p' + n] = { state: 'OPEN', headRefOid: 'aaa1111' + '0'.repeat(33), mergeable: calls > 1 && n === '40' ? 'CONFLICTING' : 'UNKNOWN' };
    process.stdout.write(JSON.stringify({ data: { repository: repo } }));`);
  const gh = { CB_GH: f, CB_GH_CACHE: join(dir, `cache${n}.json`) };
  const r = cb(['tick', 'demo'], gh);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /READY TO MERGE/);
  assert.match(r.out, /STUCK\n\s+#40 GO@aaa1111 CONFLICTING/);
  assert.match(r.out, /GO WITH CONDITIONS \(check first\)\n\s+#41 GO@aaa1111 = head, GitHub has not computed mergeability yet: "GO: fine" → check, then gh pr merge 41 /);
  // UNKNOWN isn't cached: the next tick asks GitHub again
  const before = +readFileSync(count, 'utf8');
  cb(['tick', 'demo'], gh);
  assert.ok(+readFileSync(count, 'utf8') > before);
});

test('tick: board vs GitHub uses only the task\'s current links.pr, never PR numbers in its title or history (#233)', async () => {
  const sql = await db();
  // a follow-up created pointing at its parent PR, then relinked to its own PR
  await sql`select cb.task_add(project => 'demo', title => 'Follow-up to #2792: money-shaped figures only', body => 'see PR #2792', status => 'in_progress',
    assignee => 'W7@m', links => ${sql.json({ pr: URL + '2792' })}, actor => 'orch@test')`;
  const gh = { 2792: { state: 'MERGED', headRefOid: '1'.repeat(40), mergeable: 'UNKNOWN' }, 2816: { state: 'OPEN', headRefOid: '2'.repeat(40), mergeable: 'MERGEABLE' } };
  assert.match(cb(['tick', 'demo'], fakeGh(gh)).out, /#1 in_progress but PR #2792 merged/); // what the orchestrator saw before the relink
  await sql`select cb.task_update('1', ${sql.json({ links: { pr: URL + '2816' } })}, 'W7@m')`;
  await sql`select cb.task_move('1', 'review', 'PR #2816 up', 'W7@m')`;
  const r = cb(['tick', 'demo'], fakeGh(gh));
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /PR #2792/); // the title still says #2792; only links.pr (2816, open) is checked
  assert.doesNotMatch(r.out, /BOARD VS GITHUB/);
});

test('tick: GitHub results are cached for 5 minutes', async () => {
  const sql = await db();
  await seedReviews(sql);
  const gh = fakeGh(KNOWN);
  cb(['tick', 'demo'], { ...gh, GITHUB_REPO_DEMO: 'acme/app' });
  writeFileSync(gh.CB_GH, `process.exit(9)`); // gh now fails: the cache answers
  const r = cb(['tick', 'demo'], { ...gh, GITHUB_REPO_DEMO: 'acme/app' });
  assert.match(r.out, /#10 GO@aaa1111 = head/);
  assert.doesNotMatch(r.out, /skipped/);
});

test('tick: without gh, the board sections still print, with one line saying why GitHub was skipped', async () => {
  const sql = await db();
  await seedReviews(sql);
  await sql`select cb.task_add(project => 'demo', title => 'quiet', status => 'in_progress', assignee => 'W1@m', actor => 'W1@m')`;
  await ago(sql, sql`actor = 'W1@m'`, '1 hour');
  const r = cb(['tick', 'demo'], { ...fakeGh(null), GITHUB_REPO_DEMO: 'acme/app' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /#10 W1@m silent 1h/);
  assert.doesNotMatch(r.out, /READY TO MERGE/);
  assert.match(r.out, /^GitHub checks skipped for acme\/app: gh failed \(To get started with GitHub CLI, please run: gh auth login\)$/m);
});

test('tick: one failing repo skips only that repo, and its failure is cached for a minute', async () => {
  const sql = await db();
  await seedReviews(sql);
  await sql`select cb.task_add(project => 'demo', title => 'other repo', status => 'in_progress', assignee => 'W6@m', links => ${sql.json({ pr: 'https://github.com/acme/bad/pull/14' })}, actor => 'W6@m')`;
  const gh = fakeGh(KNOWN, 'bad');
  let r = cb(['tick', 'demo'], { ...gh, GITHUB_REPO_DEMO: 'acme/app' });
  assert.match(r.out, /#10 GO@aaa1111 = head/);
  assert.match(r.out, /^GitHub checks skipped for acme\/bad: gh failed \(GraphQL: Could not resolve to a Repository\)$/m);
  assert.doesNotMatch(r.out, /skipped for acme\/app/);
  // within the minute the broken repo isn't asked again: its cached failure answers
  writeFileSync(gh.CB_GH, `process.stderr.write('called again\\n'); process.exit(9)`);
  r = cb(['tick', 'demo'], { ...gh, GITHUB_REPO_DEMO: 'acme/app' });
  assert.match(r.out, /^GitHub checks skipped for acme\/bad: gh failed \(GraphQL: Could not resolve to a Repository\)$/m);
  assert.doesNotMatch(r.out, /called again/);
});

test('tick: a ready-to-merge PR is re-checked if its cached state is over a minute old; others keep the 5-minute cache', async () => {
  const sql = await db();
  await seedReviews(sql);
  const gh = fakeGh({ ...PRS, 10: { ...PRS[10], headRefOid: 'abcdef1' + '0'.repeat(33) }, 14: { ...PRS[14], state: 'OPEN' } });
  const old = Date.now() - 2 * 60_000;
  writeFileSync(gh.CB_GH_CACHE, JSON.stringify({
    'acme/app#10': { state: 'OPEN', head: 'aaa1111' + '0'.repeat(33), mergeable: 'MERGEABLE', at: old },
    'acme/app#14': { state: 'MERGED', head: '1'.repeat(40), mergeable: 'UNKNOWN', at: old },
  }));
  const r = cb(['tick', 'demo'], { ...gh, GITHUB_REPO_DEMO: 'acme/app' });
  assert.match(r.out, /#10 GO@aaa1111, HEAD MOVED to abcdef1000/); // a stale "= head" would have merged an unreviewed commit
  assert.match(r.out, /#8 in_progress but PR #14 merged/); // 2 minutes old: still from the cache
});

test('tick: a short or non-hex reviewed commit never matches the head; a garbage cache is ignored', async () => {
  const sql = await db();
  await sql`select cb.task_add(project => 'demo', title => 'Review #20', status => 'in_progress', labels => '["review"]', assignee => 'W3@m', actor => 'W3@m')`;
  await sql`select cb.task_done('1', 'GO', ${sql.json({ pr: URL + '20', commit: 'aa' })}, 'W3@m')`;
  await sql`select cb.task_add(project => 'demo', title => 'Review #21', status => 'in_progress', labels => '["review"]', assignee => 'W3@m', actor => 'W3@m')`;
  await sql`select cb.task_done('2', 'GO', ${sql.json({ pr: URL + '21', commit: 'zzzzzzz' })}, 'W3@m')`;
  for (const garbage of ['null', '[]', '"x"', '{"acme/app#20": 5}', '{"acme/app#20": {"at": 9e15}}']) {
    const gh = fakeGh({ 20: { state: 'OPEN', headRefOid: 'aa' + '0'.repeat(38), mergeable: 'MERGEABLE' },
      21: { state: 'OPEN', headRefOid: 'zzzzzzz' + '0'.repeat(33), mergeable: 'MERGEABLE' } });
    writeFileSync(gh.CB_GH_CACHE, garbage);
    const r = cb(['tick', 'demo'], gh);
    assert.equal(r.code, 0, `${garbage}: ${r.err}`);
    assert.doesNotMatch(r.out, /gh pr merge/, garbage);
    assert.match(r.out, /#20 GO@aa, HEAD MOVED/, garbage);
  }
});

test('q quotes for bash and PowerShell: safe words bare, the rest single-quoted with every quote doubled', async () => {
  const { q } = await import('../cli/tick.ts');
  assert.equal(q('W3@macbook'), 'W3@macbook');
  assert.equal(q('pr=https://github.com/acme/app/pull/1'), 'pr=https://github.com/acme/app/pull/1');
  assert.equal(q("it's"), "'it''s'");
  assert.equal(q('’; calc; ’'), "'''; calc; '''");
  assert.equal(q('‘a‚b‛'), "'''a''b'''");
  assert.equal(q('#12'), "'#12'"); // a bare # starts a comment
  assert.equal(q('-x'), "'-x'");
  assert.equal(q('$(id)'), "'$(id)'");
});

test('tick: hostile titles, actors and PR links print as inert commands in bash and PowerShell', async () => {
  const sql = await db();
  const evil = "x’; touch PWN1; ’ $(touch PWN2) `touch PWN3` it's";
  await sql`select cb.task_add(project => 'demo', title => ${evil}, status => 'review', assignee => 'W$(touch PWN4)@m',
    links => ${sql.json({ pr: 'https://github.com/ac;me/a$(touch PWN5)/pull/17' })}, actor => 'W$(touch PWN4)@m')`;
  await sql`select cb.task_add(project => 'demo', title => ${evil}, status => 'in_progress', assignee => 'W1’;touch PWN6;’@m', actor => 'W1’;touch PWN6;’@m')`;
  await sql`select cb.task_add(project => 'demo', title => 'held', status => 'in_progress', assignee => 'A’@m', actor => 'orch@test')`;
  await sql`select cb.log('demo', 'mine now', '3', '{}', ${"B`touch PWN7`@m"})`;
  await sql`select cb.ask(project => 'demo', body => 'q?', actor => 'W$(touch PWN8)@m')`;
  await sql`select cb.answer('1', ${evil})`;
  await ago(sql, sql`actor like 'W1%'`, '2 hours');
  const r = cb(['tick', 'demo'], fakeGh({ 17: { state: 'OPEN', headRefOid: '3'.repeat(40), mergeable: 'MERGEABLE' } }));
  assert.equal(r.code, 0, r.err);
  const cmds = r.out.split('\n').filter((l) => l.includes(' → ')).map((l) => l.slice(l.indexOf(' → ') + 3));
  assert.ok(cmds.length >= 4, r.out);
  assert.doesNotMatch(r.out, /skipped for ac;me/); // an invalid repo is never handed to gh
  const shells: [string, string[], string][] = [
    ['bash', ['-c'], `cb() { printf '<%s>' "$@"; echo; }; gh() { cb "$@"; }; ${cmds.join('\n')}`],
    ['pwsh', ['-NoProfile', '-Command'], `function cb { '<' + ($args -join '><') + '>' }; function gh { cb @args }; ${cmds.join('\n')}`],
  ];
  for (const [sh, flags, script] of shells) {
    const cwd = mkdtempSync(join(dir, `${sh}-`));
    const run = spawnSync(sh, [...flags, script], { cwd, encoding: 'utf8' });
    if (run.error) continue; // shell not installed here
    assert.equal(run.status, 0, `${sh}: ${run.stderr}`);
    assert.deepEqual(readdirSync(cwd), [], `${sh} ran something:\n${cmds.join('\n')}`);
    assert.match(run.stdout, /\$\(touch PWN4\)/, sh); // arrives as text
  }
});
