// Synthetic, realistic data for design work. Wipes and refills a *_demo database only.
// CB_DATABASE_URL=postgres://cb@127.0.0.1:5434/claude_board_design_demo node docs/design/seed.ts
import { sql } from '../../server/db.ts';
import { callFn } from '../../server/rpc.ts';

const db = (await sql`select current_database() as d`)[0].d as string;
if (!db.endsWith('_demo')) throw new Error(`refusing to seed ${db}: only *_demo databases`);

await sql`truncate cb.events, cb.questions, cb.tasks, cb.sessions restart identity cascade`;
await sql`delete from cb.huddles`.catch(() => {});
await sql`delete from cb.projects`;

const W1 = 'W1@macbook', W2 = 'W2@macbook', W3 = 'W3@macbook', R1 = 'R1@macbook', OR = 'orch@shaltoot', V = 'fetch@vps2';
const core = 'claims-core', portal = 'reviewer-portal', ml = 'fraud-ml', board = 'claude-board';
const add = (project: string, title: string, o: Record<string, unknown> = {}) =>
  callFn('task_add', { project, title, actor: OR, ...o }) as Promise<number>;

await callFn('user_add', { name: 'omar', display: 'Omar' }).catch(() => {});

const T: Record<string, number> = {};
const specs: [string, string, string, Record<string, unknown>][] = [
  ['retry', core, 'Retry policy for upstream 503s from the payer gateway', { status: 'next', priority: 'P1', labels: ['payer-gw', 'reliability'], body: 'Exponential backoff, max 5 tries, full jitter. Log each retry with the request id so support can trace a claim end to end.' }],
  ['index', core, 'Composite index on claims(status, submitted_at)', { status: 'next', priority: 'P1', labels: ['perf', 'postgres'], body: 'Dashboard query does a seq scan over 31M rows. `EXPLAIN (ANALYZE, BUFFERS)` in the PR.' }],
  ['rotate', core, 'Rotate staging database credentials', { status: 'in_progress', priority: 'P0', assignee: W1, labels: ['security'] }],
  ['batch', core, 'Batch submit endpoint with per-item results', { status: 'in_progress', priority: 'P1', assignee: W1, labels: ['payer-gw'], links: { branch: 'feat/batch-submit' } }],
  ['blob', core, 'Move attachments to blob storage v2', { status: 'in_progress', priority: 'P2', assignee: W2, labels: ['infra', 'attachments'] }],
  ['xml', core, 'Remove the legacy XML exporter', { status: 'backlog', priority: 'P3', labels: ['cleanup'] }],
  ['ratelimit', core, 'Rate-limit the public status endpoint', { status: 'backlog', priority: 'P2', labels: ['reliability'] }],
  ['contract', core, 'Contract tests for the payer gateway', { status: 'backlog', priority: 'P1', labels: ['payer-gw', 'tests'] }],
  ['dedupe', core, 'Duplicate-claim check across resubmissions', { status: 'review', priority: 'P1', assignee: W3, labels: ['rules'], links: { pr: '#1184' } }],
  ['icd', core, 'Validate ICD-10 codes against the 2026 code set', { status: 'next', priority: 'P2', labels: ['rules', 'coding'] }],
  ['ocr-split', core, 'Split multi-claim PDFs before OCR', { status: 'blocked', priority: 'P1', assignee: W2, labels: ['ocr', 'attachments'] }],
  ['eligibility', core, 'Cache eligibility responses for 15 minutes', { status: 'backlog', priority: 'P2', labels: ['payer-gw', 'perf'] }],
  ['audit', core, 'Audit log for manual claim edits', { status: 'backlog', priority: 'P2', labels: ['compliance'] }],
  ['currency', core, 'Store amounts as integer minor units', { status: 'done', priority: 'P1', assignee: W1, labels: ['money'] }],
  ['pgbouncer', core, 'Put PgBouncer in front of the write pool', { status: 'done', priority: 'P2', assignee: W3, labels: ['postgres', 'infra'] }],
  ['dark', portal, 'Dark mode for the reviewer screen', { status: 'review', priority: 'P2', assignee: W2, labels: ['ux'], links: { pr: '#412' } }],
  ['kbd', portal, 'Keyboard shortcuts on the claim list', { status: 'next', priority: 'P2', labels: ['ux'] }],
  ['tz', portal, 'Date picker shows the wrong day after 21:00', { status: 'done', priority: 'P1', assignee: W2, labels: ['bug'] }],
  ['empty', portal, 'Empty state for search results', { status: 'backlog', priority: 'P3', labels: ['ux'] }],
  ['bundle', portal, 'Bundle size budget in CI', { status: 'backlog', priority: 'P3', labels: ['perf', 'ci'] }],
  ['diff', portal, 'Side-by-side diff of claim versions', { status: 'in_progress', priority: 'P1', assignee: R1, labels: ['review', 'ux'] }],
  ['a11y', portal, 'Screen-reader pass on the approval flow', { status: 'next', priority: 'P2', labels: ['ux', 'a11y'] }],
  ['export', portal, 'CSV export keeps Arabic names intact', { status: 'blocked', priority: 'P2', assignee: R1, labels: ['bug', 'i18n'] }],
  ['retrain', ml, 'Retrain the anomaly model on 2026 data', { status: 'blocked', priority: 'P1', assignee: V, labels: ['model', 'eval'] }],
  ['tokenizer', ml, 'Evaluate the new tokenizer on long clinical notes', { status: 'next', priority: 'P2', labels: ['eval'] }],
  ['codemap', ml, 'Dedup the procedure code mapping table', { status: 'done', priority: 'P2', assignee: W1, labels: ['data'] }],
  ['bench', ml, 'Download the benchmark set (40 GB)', { status: 'in_progress', priority: 'P2', assignee: V, labels: ['data'] }],
  ['report', ml, 'Eval report template with confusion matrix', { status: 'backlog', priority: 'P3', labels: ['eval'] }],
  ['drift', ml, 'Weekly feature drift alert', { status: 'backlog', priority: 'P2', labels: ['model', 'monitoring'] }],
  ['gpu', ml, 'GPU capacity estimate for batch scoring', { status: 'review', priority: 'P1', assignee: V, labels: ['capacity'], links: { pr: '#88' } }],
  ['thresh', ml, 'Per-provider score thresholds', { status: 'next', priority: 'P0', labels: ['model', 'rules'], body: 'Same threshold for every provider flags small clinics far too often. Calibrate per volume band.' }],
  ['relay', board, 'Relay reconnects after the laptop sleeps', { status: 'done', priority: 'P0', assignee: W3, labels: ['relay'] }],
  ['priority', board, 'One-click priority on cards', { status: 'in_progress', priority: 'P1', assignee: W3, labels: ['ui'] }],
  ['guest', board, 'Guest links for teammates to answer questions', { status: 'review', priority: 'P2', assignee: R1, labels: ['ui', 'users'] }],
  ['tick', board, 'cb tick: one-line status from the CLI', { status: 'next', priority: 'P3', labels: ['cli'] }],
  ['digest', board, 'Morning digest of overnight answers', { status: 'backlog', priority: 'P3', labels: ['ui'] }],
  ['huddle-ui', board, 'Show huddle outcomes on the task', { status: 'backlog', priority: 'P2', labels: ['ui', 'huddles'] }],
  ['search', board, 'Full-text search across task bodies', { status: 'backlog', priority: 'P3', labels: ['ui'] }],
  ['nightly', core, 'Nightly reconciliation report shows totals per payer', { status: 'done', priority: 'P2', assignee: W2, labels: ['money', 'reports'] }],
  ['flaky', core, 'Quarantine the flaky settlement test', { status: 'done', priority: 'P3', assignee: W1, labels: ['tests'] }],
];
for (const [k, p, title, o] of specs) T[k] = await add(p, title, o);

const mv = (k: string, status: string, note: string, actor: string) => callFn('task_move', { id: String(T[k]), status, note, actor });
const log = (p: string, k: string, summary: string, actor: string) => callFn('log', { project: p, summary, task_id: String(T[k]), actor });
const done = (k: string, summary: string, links: object, actor: string) => callFn('task_done', { id: String(T[k]), summary, links, actor });

await log(core, 'index', 'p95 on /claims dropped from 840 ms to 120 ms on a restored copy', W2);
await mv('dedupe', 'review', 'opened PR #1184', W3);
await done('pgbouncer', 'transaction pooling on; 400 → 60 server connections', { pr: '#1170' }, W3);
await log(ml, 'bench', 'benchmark download at 62%, about 40 minutes left', V);
await done('tz', 'store as date, not timestamp; added a test at 23:30 local', { pr: '#409', commit: '4be19c0' }, W2);
await log(core, 'blob', 'copied 1.2M of 3.4M attachments; checksums match so far', W2);
await done('codemap', 'removed 1,204 duplicate rows; added a unique constraint', { pr: '#77', commit: '9f3c2ab' }, W1);
await log(portal, 'diff', 'diff renders field-level changes; working on line items', R1);
await done('relay', 'reconnect with backoff; inbox replays missed events', { pr: '#141' }, W3);
await mv('gpu', 'review', 'estimate: 2×L4 covers the nightly batch with 35% headroom', V);
await done('nightly', 'totals now grouped by payer and currency', { pr: '#1166' }, W2);
await done('flaky', 'moved to the quarantine suite with a tracking task', {}, W1);
await done('currency', 'migrated 31M rows; no rounding differences on the sample', { pr: '#1159' }, W1);
await callFn('broadcast', { message: 'Freeze on claims-core merges from 18:00 for the release cut.', project: core, actor: OR });

const ask = (o: Record<string, unknown>) => callFn('ask', o) as Promise<number>;
await ask({ project: core, actor: W1, task_id: String(T.rotate), blocking: true,
  body: 'The staging database password is also used by the nightly report job. Rotate now and break tonight\'s report, or wait until Friday\'s cutover?',
  context: 'Rotating now means the report job fails until someone updates its secret.\n\n- Job: `nightly-claims-report`\n- Owner: data team\n- Last rotation: 14 months ago',
  options: [{ label: 'Rotate now (Recommended)', description: 'The credential was in a committed .env. I update the report job\'s secret right after.' },
            { label: 'Wait until Friday', description: 'Keeps tonight\'s report. The leaked password stays valid three more days.' }],
  reply_to: { machine: 'macbook', pane: 'w1' } });
await ask({ project: ml, actor: V, task_id: String(T.retrain), blocking: true,
  body: 'Retrain on all of 2026, or exclude March? The labelling vendor changed that month.',
  options: [{ label: 'All of 2026', description: 'More data; March labels are noisier.' },
            { label: 'Exclude March (Recommended)', description: 'Cleaner labels, 8% less data.' }] });
await ask({ project: core, actor: W2, task_id: String(T['ocr-split']), blocking: true,
  body: 'Some scanned bundles have no page separators. Split on the cover-sheet barcode, or send them to manual review?',
  options: [{ label: 'Split on the barcode', description: 'Works for 92% of the sample. Misses hand-written cover sheets.' },
            { label: 'Manual review queue', description: 'Safe, but adds about 40 bundles a day to the reviewers.' },
            { label: 'Both: barcode first, manual if none found', description: 'A little more code; best coverage.' }] });
await ask({ project: portal, actor: W2, multi: true,
  body: 'Which screens should get the new keyboard shortcuts first?',
  options: [{ label: 'Claim list', description: null }, { label: 'Reviewer screen', description: null }, { label: 'Search', description: null }, { label: 'Settings', description: null }] });
await ask({ project: core, actor: W3, task_id: String(T.dedupe),
  body: 'Treat a resubmission with a changed service date as a duplicate?',
  options: [{ label: 'Yes, flag it', description: 'Catches date-shifting. Some legitimate corrections get flagged.' },
            { label: 'No, only identical claims', description: 'Fewer false positives.' }] });
await ask({ project: core, actor: W2, body: 'OK to bump the blob SDK to v12? It drops Node 18, and staging still runs 18 on one worker.' });
const q7 = await ask({ project: core, actor: OR, body: 'Should batch submit accept partial success (207) or fail the whole batch?',
  options: [{ label: '207 partial', description: 'Callers retry only failures.' }, { label: 'All or nothing', description: 'Simpler for callers.' }] });
await callFn('answer', { id: String(q7), answer: '207 partial, with per-item errors', actor: 'ahmed' });
const q8 = await ask({ project: portal, actor: R1, task_id: String(T.export), body: 'Export as UTF-8 with BOM so Excel opens Arabic names correctly?',
  options: [{ label: 'Yes, add the BOM', description: null }, { label: 'No, offer XLSX instead', description: null }] });
await callFn('answer', { id: String(q8), answer: 'Yes, add the BOM', actor: 'ahmed' });
const q9 = await ask({ project: board, actor: W3, task_id: String(T.priority), body: 'Show the priority picker on hover only, or always?' });
await callFn('question_assign', { id: String(q9), to_user: 'omar', actor: 'ahmed' }).catch(() => {});

const h = await callFn('huddle_open', { topic: 'Where should duplicate detection run: at intake or at adjudication?', members: [W3, W1, R1], task: String(T.dedupe), actor: W3, project: core });
const say = (m: string, a: string) => callFn('huddle_say', { id: String(h), message: m, actor: a });
await say('Intake is cheaper: we reject before OCR and save the attachment storage.', W3);
await say('But at intake we don\'t have the coded procedures yet, only the header. We\'d miss duplicates that differ only in line items.', W1);
await say('Reviewers mostly see line-item duplicates. Header-only matching would catch maybe a third of what they flag by hand.', R1);
await say('Then two passes: a cheap header check at intake, full check at adjudication. Intake only blocks exact matches.', W3);
await say('Agreed. I\'ll keep the adjudication check behind a flag until we\'ve compared it with the manual flags for a week.', W1);
const h2 = await callFn('huddle_open', { topic: 'GPU sizing for nightly scoring', members: [V, OR], task: String(T.gpu), actor: V, project: ml });
await callFn('huddle_say', { id: String(h2), message: 'Two L4s finish the nightly batch in 3h10m with room to spare.', actor: V });
await callFn('huddle_say', { id: String(h2), message: 'Go with two. Revisit when the provider count doubles.', actor: OR });
await callFn('huddle_close', { id: String(h2), summary: 'Two L4s; revisit at double the provider count.', actor: OR });

// Sessions: some with a live relay (last_seen far ahead so the dots stay lit for screenshots).
for (const [actor, pane, project] of [[W1, 'w1', core], [W2, 'w2', core], [W3, 'w3', board], [R1, 'r1', portal], [V, 'v1', ml], [OR, 'orch', core]] as const)
  await callFn('iam', { machine: actor.split('@')[1], pane, actor, project });
await sql`update cb.sessions set last_seen = now() + interval '30 days' where actor <> ${R1}`;
await sql`update cb.sessions set last_seen = now() - interval '25 minutes' where actor = ${R1}`;

// Spread history over the last ~20 hours, keeping order.
await sql`update cb.events set at = now() - ((select max(id) from cb.events) - id) * interval '14 minutes'`;
await sql`update cb.tasks t set updated_at = coalesce((select max(e.at) from cb.events e where e.task_id = t.id), t.updated_at),
  created_at = coalesce((select min(e.at) from cb.events e where e.task_id = t.id), t.created_at),
  done_at = case when t.status = 'done' then (select max(e.at) from cb.events e where e.task_id = t.id) end`;
await sql`update cb.questions q set created_at = coalesce((select min(e.at) from cb.events e where e.question_id = q.id), q.created_at)`;
await sql`select cb.seen(now() - interval '9 hours')`;
console.log(`seeded ${specs.length} tasks`);
await sql.end();
