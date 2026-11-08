// Synthetic demo data in demo-* projects. `node db/seed.ts --remove` deletes it again.
import { sql } from '../server/db.ts';
import { callFn } from '../server/rpc.ts';
import { ensurePg } from './pg.ts';

ensurePg();
await sql`delete from cb.events where project like 'demo-%'`;
await sql`update cb.tasks set blocked_on = null where project like 'demo-%'`;
await sql`delete from cb.questions where project like 'demo-%'`;
await sql`delete from cb.tasks where project like 'demo-%'`;
await sql`delete from cb.projects where slug like 'demo-%'`;
if (process.argv.includes('--remove')) { console.log('demo data removed'); await sql.end(); process.exit(0); }

const firstEvent = (await sql`select coalesce(max(id), 0) as id from cb.events`)[0].id;
const W1 = 'W1@macbook', W2 = 'W2@macbook', OR = 'orch@shaltoot', V = 'scraper@vps2';
const add = (project: string, title: string, o: Record<string, unknown> = {}) =>
  callFn('task_add', { project, title, actor: OR, ...o }) as Promise<number>;

const api = 'demo-api', web = 'demo-web', ml = 'demo-ml';
const t: number[] = [];
t.push(await add(api, 'Retry policy for upstream 503s', { status: 'next', priority: 'P1', body: 'Exponential backoff, max 5 tries, jitter. Log each retry with the request id.' }));
t.push(await add(api, 'Index on claims(status, created_at)', { status: 'next', body: 'Seq scan on the dashboard query. `EXPLAIN ANALYZE` attached in the PR description.' }));
t.push(await add(api, 'Rotate staging DB credentials', { status: 'in_progress', priority: 'P0', assignee: W1 }));
t.push(await add(api, 'Batch submit endpoint', { status: 'in_progress', assignee: W1, links: { branch: 'feat/batch-submit' } }));
t.push(await add(api, 'Move attachments to blob storage v2', { status: 'in_progress', assignee: W2 }));
t.push(await add(api, 'Remove legacy XML exporter', { status: 'backlog', priority: 'P3' }));
t.push(await add(api, 'Rate-limit the public status endpoint', { status: 'backlog' }));
t.push(await add(api, 'Contract tests for the payer gateway', { status: 'backlog', priority: 'P1' }));
t.push(await add(web, 'Dark mode for the reviewer screen', { status: 'review', assignee: W2, links: { pr: '#412' } }));
t.push(await add(web, 'Keyboard shortcuts on the claim list', { status: 'next' }));
t.push(await add(web, 'Fix date picker timezone bug', { status: 'done', assignee: W2 }));
t.push(await add(web, 'Empty state for search results', { status: 'backlog', priority: 'P3' }));
t.push(await add(web, 'Bundle size budget in CI', { status: 'backlog' }));
t.push(await add(ml, 'Retrain fraud model on 2026 data', { status: 'blocked', assignee: V }));
t.push(await add(ml, 'Evaluate the new tokenizer on long notes', { status: 'next', priority: 'P2' }));
t.push(await add(ml, 'Dedup the code mapping table', { status: 'done', assignee: W1 }));
t.push(await add(ml, 'Download benchmark set (40 GB)', { status: 'in_progress', assignee: V }));
t.push(await add(ml, 'Write eval report template', { status: 'backlog' }));

await callFn('task_move', { id: String(t[3]), status: 'review', note: 'opened PR #418', actor: W1 });
await callFn('log', { project: api, summary: 'p95 on /claims dropped from 840ms to 120ms after the index experiment on a copy', task_id: String(t[1]), actor: W2 });
await callFn('task_done', { id: String(t[15]), summary: 'removed 1,204 duplicate rows; added unique constraint', links: { pr: '#77', commit: '9f3c2ab' }, actor: W1 });
await callFn('log', { project: ml, summary: 'benchmark download at 62%, ETA 40 min', task_id: String(t[16]), actor: V });

await callFn('ask', { project: api, actor: W1, task_id: String(t[2]), blocking: true,
  body: 'The staging DB password is also used by the nightly report job. Rotate now and break tonight\'s report, or wait until Friday\'s cutover?',
  context: 'Rotating now means the report job fails until someone updates its secret.\n\n- Job: `nightly-claims-report`\n- Owner: data team',
  options: [{ label: 'Rotate now (Recommended)', description: 'Credential was in a committed .env. I update the report job secret right after.' },
            { label: 'Wait until Friday', description: 'Keeps tonight\'s report. The leaked password stays valid 3 more days.' }],
  reply_to: { machine: 'macbook', pane: 'w1' } });
await callFn('ask', { project: ml, actor: V, task_id: String(t[13]), blocking: true,
  body: 'Retrain on all 2026 data, or exclude March (the labelling vendor changed)?',
  options: [{ label: 'All of 2026', description: 'More data; March labels are noisier.' },
            { label: 'Exclude March (Recommended)', description: 'Cleaner labels, 8% less data.' }] });
await callFn('ask', { project: web, actor: W2, multi: true,
  body: 'Which screens should get the new keyboard shortcuts first?',
  options: ['Claim list', 'Reviewer screen', 'Search', 'Settings'] });
const q4 = await callFn('ask', { project: api, actor: OR, body: 'Should batch submit accept partial success (207) or fail the whole batch?',
  options: [{ label: '207 partial', description: 'Callers retry only failures.' }, { label: 'All or nothing', description: 'Simpler for callers.' }] });
await callFn('answer', { id: String(q4), answer: '207 partial — include per-item errors', actor: 'ahmed' });
await callFn('ask', { project: api, actor: W2, body: 'OK to bump the blob SDK to v12? It drops Node 18.' });

// Spread the history over the last ~18 hours, keeping order.
await sql`update cb.events set at = now() - ((select max(id) from cb.events) - id) * interval '33 minutes' where id > ${firstEvent}`;
await sql`update cb.tasks t set updated_at = coalesce((select max(e.at) from cb.events e where e.task_id = t.id), t.updated_at),
  created_at = coalesce((select min(e.at) from cb.events e where e.task_id = t.id), t.created_at),
  done_at = case when t.status = 'done' then (select max(e.at) from cb.events e where e.task_id = t.id) end
  where t.project like 'demo-%'`;
await sql`update cb.questions q set created_at = (select min(e.at) from cb.events e where e.question_id = q.id) where q.project like 'demo-%'`;
await sql`select cb.seen(now() - interval '14 hours')`;
console.log(`seeded ${t.length} tasks in demo-api, demo-web, demo-ml`);
await sql.end();
