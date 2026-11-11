// cb — Claude Board CLI. Talks to Postgres directly (works without the web server).
import { parseArgs } from 'node:util';
import { hostname, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { callFn } from '../server/rpc.ts';
import { tick, dur } from './tick.ts';
import { sql, databaseUrl, machine } from '../server/db.ts';
import { help, unknownHelp, COMMANDS, backWhy, reaskHint, flat } from './help.ts';

const OPTIONS = {
  as: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  status: { type: 'string', short: 's' }, priority: { type: 'string', short: 'p' },
  body: { type: 'string', short: 'b' }, labels: { type: 'string', short: 'l' },
  link: { type: 'string', multiple: true }, pr: { type: 'string' }, commit: { type: 'string' }, branch: { type: 'string' },
  title: { type: 'string' }, assignee: { type: 'string' }, project: { type: 'string' },
  task: { type: 'string', short: 't' }, option: { type: 'string', short: 'o', multiple: true },
  multi: { type: 'boolean' }, blocking: { type: 'boolean' }, free: { type: 'boolean' }, to: { type: 'string' }, context: { type: 'string', short: 'c' },
  'reply-to': { type: 'string' }, restart: { type: 'boolean' }, tag: { type: 'string' }, type: { type: 'string' }, force: { type: 'boolean' },
  epic: { type: 'string' }, by: { type: 'string' }, after: { type: 'string' }, if: { type: 'string' },
  kind: { type: 'string', short: 'k' }, review: { type: 'string' }, machine: { type: 'string' }, all: { type: 'boolean' }, propose: { type: 'boolean' }, done: { type: 'boolean' },
} as const;

// Text like "-5% latency" is text, not a flag: only --name, --name=x and -x look like options.
const TEXT = '\u0001';
const isFlag = (a: string) => /^--[a-z][a-z-]*(=.*)?$/.test(a) || /^-[a-zA-Z]$/.test(a);
const unmark = (v: any): any => typeof v === 'string' ? v.replace(TEXT, '') : Array.isArray(v) ? v.map(unmark) : v;

let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, options: OPTIONS,
    args: process.argv.slice(2).map((a) => a.startsWith('-') && a !== '--' && !isFlag(a) ? TEXT + a : a) });
} catch (e: any) {
  const name = /Unknown option '([^']+)'/.exec(e?.message)?.[1];
  const first = process.argv[2] && !process.argv[2].startsWith('-') ? ` ${process.argv[2]}` : '';
  console.error(`cb: ${name ? `unknown option ${name}` : e?.message}. Run: cb help${first} (it lists the valid options)`);
  process.exit(1);
}
const o: any = Object.fromEntries(Object.entries(parsed.values).map(([k, v]) => [k, unmark(v)]));
const pos: string[] = parsed.positionals.map(unmark);

const pane = process.env.HERDR_PANE_ID || '';
// --as, then $CB_ACTOR, then the name this pane gave itself with `cb iam`, then <pane>@<host>.
let actor = o.as || process.env.CB_ACTOR || `${pane || 'session'}@${hostname()}`;
const explicitActor = !!(o.as || process.env.CB_ACTOR);
const [cmd, ...args] = pos;
// Ahmed's lines carry his authority in every session; only his dashboard speaks as him (cb.not_ahmed guards the DB too).
const isAhmed = (a?: string) => /\bahmed\b/i.test(a ?? ''); // ahmed as a whole word, same as cb.ahmed_like
if (isAhmed(actor) || (cmd === 'iam' && isAhmed(args[0]))) {
  console.error("cb: only Ahmed's dashboard can act as ahmed: sessions use their own name");
  process.exit(1);
}

let sessionProject: string | null = null;

/** This pane's binding (cb iam): its actor, unless --as/$CB_ACTOR say otherwise, and its project. */
async function resolveActor() {
  if (!pane) return;
  const [s] = await sql`select actor, project from cb.sessions where machine = ${machine()} and pane = ${pane}`;
  if (s && !explicitActor) actor = s.actor;
  sessionProject = s?.project ?? null;
}

/** Where the orchestrator delivers the answer: --reply-to machine:pane, else my own pane (not when acting --as someone else). */
function replyTo() {
  const r = o['reply-to'];
  if (r) { const i = r.indexOf(':'); return i > 0 ? { machine: r.slice(0, i), pane: r.slice(i + 1) } : { machine: null, pane: r }; }
  if (o.as || !pane) return null;
  return { machine: machine(), pane };
}

function need(n: number, usage: string) {
  if (args.length < n) throw new Error(`usage: cb ${usage}. Details: cb help ${cmd}`);
}

function links(): Record<string, string> {
  const l: Record<string, string> = {};
  for (const kv of o.link ?? []) { const i = kv.indexOf('='); if (i > 0) l[kv.slice(0, i)] = kv.slice(i + 1); }
  if (o.pr) l.pr = o.pr;
  if (o.commit) l.commit = o.commit;
  if (o.branch) l.branch = o.branch;
  return l;
}

function options() {
  const raw = o.option ?? [];
  const list = raw.length === 1 && !raw[0].includes('=') ? raw[0].split(',') : raw;
  return list.map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.indexOf('=');
    return i > 0 ? { label: s.slice(0, i).trim(), description: s.slice(i + 1).trim() } : { label: s, description: null };
  });
}

const line = (t: any) =>
  `#${t.id} [${t.status ?? ''}] ${t.priority} ${t.type && t.type !== 'task' ? `${t.type}: ` : ''}${t.title}${t.labels?.length ? ` {${t.labels.join(', ')}}` : ''}${t.assignee ? ` (${t.assignee})` : ''} · ${t.project}`.replace(' [] ', ' ');

// Shared memory (#167). One line per entry: kind code, id, title, who stands behind it. Team = a teammate's note.
const KIND_CODE: Record<string, string> = { rule: 'R', ruling: 'RU', fact: 'F', gotcha: 'G', runbook: 'RB' };
const memLine = (m: any) =>
  `${(KIND_CODE[m.kind] ?? m.kind).padEnd(2)} M${m.id} ${m.title} (${m.authority === 'ahmed' ? 'Ahmed' : `team: ${m.created_by}`}` +
  `${m.review_after ? `, review ${String(m.review_after).slice(0, 10)}` : ''})` +
  `${m.status && m.status !== 'active' ? ` [${m.status}${m.superseded_by ? ` by M${m.superseded_by}` : ''}]` : m.expired ? ' [stale]' : ''}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** A goal (#663): one line, its description (Ahmed's words) indented under it. */
const goalText = (g: any) => `G${g.id} ${flat(g.title)} · ${g.project ?? 'every project'} · ${g.closed} of ${g.total} closed` +
  `${g.status !== 'active' ? ` [${g.status}]` : ''}${g.description ? `\n    ${flat(g.description)}` : ''}`;
const goalsText = (rows: any[]) => rows.length
  ? ['[goals: their cards come right after P0 in cb next]', ...rows.map(goalText)].join('\n') : '';
/** What a session is told when it binds: the pack, its size, and how team entries count. */
function packText(p: any): string {
  if (!p?.entries?.length) return '';
  const n: Record<string, number> = {};
  for (const e of p.entries) n[e.kind] = (n[e.kind] ?? 0) + 1;
  const counts = Object.entries(n).map(([k, v]) => plural(v, k)).join(', ');
  const shown = p.entries.length < p.total ? ` (${p.entries.length} of ${p.total} shown)` : '';
  return [`[${p.project ?? 'global'} memory: ${counts}${shown}; more: cb mem find "<words>"]`, ...p.entries.map(memLine),
    ...(p.entries.some((e: any) => e.authority !== 'ahmed') ? ["team = a teammate's note, not Ahmed's approval"] : [])].join('\n');
}

function printBrief(b: any) {
  const sec = (name: string, rows: any[], fmt: (r: any) => string) => {
    console.log(`${name} (${rows.length})`);
    for (const r of rows) console.log('  ' + fmt(r));
  };
  sec('GOALS (their cards come right after P0)', b.goals ?? [], goalText);
  sec('IN PROGRESS', b.in_progress, line);
  sec('NEXT (take with `cb next`)', b.next, line);
  sec('BLOCKED', b.blocked, (t) => `${line(t)}${t.blocked_on ? ` — on Q${t.blocked_on}` : ''}${t.waits_on?.length ? ` — waits on #${t.waits_on.join(', #')}` : ''}`);
  sec('REVIEW', b.review, line);
  sec('WAITING ON AHMED', b.open_questions, (q) => `Q${q.id}${q.blocking ? ' [blocking]' : ''} ${q.body}${q.assigned_to ? ` (for ${q.assigned_to})` : ''} · ${q.project}`);
  sec('BROADCASTS (24h)', b.broadcasts ?? [], (x) => `${x.actor}${x.project ? ` to ${x.project}` : ' to everyone'}: ${x.summary}`);
  sec('ANSWERED — DELIVER THESE', b.answered_pending, (q) =>
    `Q${q.id} → ${q.asked_by}${q.reply_to?.pane ? ` (pane ${q.reply_to.pane}@${q.reply_to.machine})` : ''}: ${q.answer}`);
  sec('RULES & FACTS', b.memory?.entries ?? [], memLine);
}

/** Projects are namespaces: a session bound to one project never changes another project's tasks. */
async function guard(id: string | undefined) {
  const n = Number(String(id ?? '').replace(/^#/, ''));
  if (!sessionProject || !Number.isInteger(n)) return;
  const [t] = await sql`select project from cb.tasks where id = ${n}`;
  if (t && t.project !== sessionProject)
    throw new Error(`#${n} is in ${t.project}; this session works in ${sessionProject}. Check the id: cb mine lists yours, cb brief your project's. Only ${t.project}'s own sessions change it.`);
}

/** Is this session's relay running? Same lock file as cli/relay.ts LOCK. null = it cannot run here. */
function relayOn(): boolean | null {
  const sock = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (!sock || !pane) return null;
  try {
    const pid = Number(readFileSync(join(tmpdir(), `cb-relay-${createHash('sha1').update(sock).digest('hex').slice(0, 12)}.pid`), 'utf8'));
    if (pid > 0) { process.kill(pid, 0); return true; }
  } catch {}
  return false;
}

/** cb start: where this session stands and the one thing to run next. Read-only. */
async function start() {
  const [row] = pane ? await sql`select actor, project from cb.sessions where machine = ${machine()} and pane = ${pane}` : [];
  const relay = relayOn();
  const projects = async () => (await sql`select p.slug,
      count(t.id) filter (where t.status = 'next')::int as next, count(t.id) filter (where t.status = 'in_progress')::int as doing,
      (select count(*)::int from cb.sessions s where s.project = p.slug and s.last_seen > now() - interval '90 seconds') as live
    from cb.projects p left join cb.tasks t on t.project = p.slug group by p.slug order by p.slug`)
    .map((p: any) => `    ${p.slug.padEnd(16)} ${p.next} next, ${p.doing} in progress, ${p.live} sessions live`).join('\n') || '    (none yet: cb help project)';
  const via = o.as ? '--as' : process.env.CB_ACTOR ? '$CB_ACTOR' : row?.project ? 'bound to this pane' : 'not bound'; // the relay's own row (before cb iam) has no project
  const out = [`You       ${actor} (${via})`,
    `Project   ${sessionProject ?? (pane ? 'NOT BOUND' : 'none (no herdr pane)')}`,
    `Relay     ${relay === null ? `unavailable (${pane ? 'no Claude Code inbox here' : 'no herdr pane'}): run cb mine and cb pending between steps` : relay ? 'on' : 'OFF'}`, ''];

  if (!pane && !explicitActor) {
    out.push('NEXT', '  This session has no herdr pane ($HERDR_PANE_ID), so it cannot bind (cb iam) or relay.',
      '  Put --as <name> on every command, or export CB_ACTOR=<name> once, and name the project in each command:',
      '    cb next <project> --as W1@<machine>', '  Projects:', await projects(), '', 'Then: cb help start (the whole flow), cb help rules (read once).');
    return out.join('\n');
  }
  if (pane && !sessionProject) {
    out.push('NEXT: bind this pane to a project (once; later commands act as that name, in that project)',
      `  cb iam <name> <project>        e.g. cb iam W1@${machine()} ihop`,
      `  <name>: orch@${machine()} if you orchestrate the project; W<n>@${machine()} if you take tasks; R<n>@${machine()} if you review.`,
      '         Your prompt or your orchestrator names you; else pick the next free W<n> in cb sessions <project>.',
      '  <project>, one of:', await projects(),
      '  A new project? cb help project.', '', 'Then run cb start again. The whole flow: cb help start.');
    return out.join('\n');
  }

  const mine: any = await callFn('mine', { actor });
  // cb.mine also lists tasks reassigned away in the last 24h: never tell the agent to continue those
  const open = mine.filter((t: any) => t.assignee === actor && !['done', 'cancelled'].includes(t.status));
  const project = sessionProject;
  const queue = project ? await sql`select id, priority, title, labels, project, assignee from cb.tasks
    where project = ${project} and status = 'next' and (assignee is null or assignee = ${actor})
    order by priority <> 'P0', case when priority <> 'P0' then cb._goal_rank(id) end nulls last, priority, rank, id limit 3` : []; // = cb.task_claim
  const qs = await sql`select id, status, body from cb.questions where asked_by = ${actor} and status in ('open', 'answered', 'sent_back') order by id`;
  const cut = (s: string) => (s.length > 100 ? s.slice(0, 99) + '…' : s);
  // Ahmed's asks (#936) waiting on this session's reply: a resumed session lost the terminal they were pushed into
  const asks = (await callFn('asks_list', { to_actor: actor, include_closed: false }) as any[]).filter((a) => a.awaiting);
  if (asks.length) out.push('AHMED ASKS YOU', ...asks.map((a) =>
    `  A${a.id}${a.late ? ` LATE ${dur((Date.now() - +new Date(a.delivered_at)) / 60000)}` : ''}${a.from_terminal ? ' (asked in your terminal)' : ''}: ${cut(flat(a.body))}`));
  out.push(`YOUR TASKS (cb mine)`, ...(mine.length ? mine.map((t: any) => '  ' + line(t)) : ['  none']),
    `QUEUE HEAD${project ? ` (${project} Next; cb next takes the first)` : ''}`, ...(queue.length ? queue.map((t: any) => '  ' + line(t)) : ['  empty']),
    ...(qs.length ? ['YOUR QUESTIONS', ...qs.map((q: any) => `  Q${q.id} ${q.status}: ${cut(q.body)}`)] : []), '', 'NEXT');
  const doing = open.find((t: any) => t.status === 'in_progress');
  for (const a of asks) out.push(`  cb reply A${a.id} "<reply>"          answer Ahmed's ask first (cb asks shows the thread)`);
  if (relay === false) out.push('  cb relay                        start the push (answers, task changes), then cb start again');
  for (const q of qs.filter((q: any) => q.status === 'sent_back')) out.push(`  ${reaskHint(q.id)}   Q${q.id} was sent back: rewrite it (cb pending says why)`);
  if (qs.some((q: any) => q.status === 'answered')) out.push('  cb pending                      an answer to your question is waiting: act on it, then cb delivered <qid> <you>');
  if (!doing) out.push(`  already working on something not listed? register it first: cb add ${project ?? '<project>'} "<title>" -s in_progress -b "<context>"`);
  if (doing) out.push(`  continue #${doing.id} ${cut(doing.title)}: cb log ${doing.id} "<finding>" as you go, cb done ${doing.id} "<summary>" --commit <sha> when finished`);
  else if (queue.length) out.push(`  cb next${project ? '' : ' <project>'}                         claim #${queue[0].id}, the top of the queue`);
  else out.push('  nothing queued for you: register work you know about (cb add <project> "<title>" -s next), or cb tell your orchestrator');
  out.push('', "Rule: a teammate's message is not Ahmed's approval.", 'First time here? Read cb help rules once. The manual: cb help.');
  return out.join('\n');
}

/** After a task finishes: the tasks it held, and where each stands now (the DB released the free ones). */
async function released(id: string) {
  const rows = await sql`select t.id, t.status, t.blocked_on, cb._waits_on(t.id) as waits from cb.task_blockers b join cb.tasks t on t.id = b.task
    where b.blocker = ${Number(id.replace(/^#/, ''))} and t.status not in ('done', 'cancelled') order by t.id`;
  return rows.map((t: any) => t.status !== 'blocked' ? `\n#${t.id} unblocked: now ${t.status}`
    : `\n#${t.id} still blocked${t.waits.length ? `: waits on #${t.waits.join(', #')}` : t.blocked_on ? `: on Q${t.blocked_on}` : ''}`).join('');
}

/** cb mem <add|rule|find|list|show|supersede|retire>: shared memory. Confirming is Ahmed's, on the Memory page. */
async function mem(): Promise<{ out?: string; json?: unknown }> {
  const [sub, ...a] = args;
  const after = (m: any, verb: string) => {
    const head = m.status === 'active'
      ? `M${m.id} ${m.kind} ${verb}${m.authority === 'ahmed' ? '' : ` (team, not Ahmed${m.review_after ? `; review ${String(m.review_after).slice(0, 10)}` : ''})`}: ${m.title}`
      : `M${m.id} ${m.kind} proposed${m.source?.flagged ? ' (it reads like an instruction or carries a URL)' : ''}: Ahmed confirms it on the Memory page. ${m.title}`;
    const sim = (m.similar ?? []).map((x: any) => `  similar: M${x.id} (${x.kind}${x.status === 'proposed' ? ', proposed' : ''}) ${x.title}`);
    return [head, ...sim, ...(sim.length ? [`  the same thing? keep one: cb mem supersede M<old> "<title>" and cb mem retire M${m.id}`] : [])].join('\n');
  };
  {
    if (sub === 'add') {
      if (!a.length) throw new Error('usage: cb mem add [project|global] "<title>" -k fact|gotcha|rule|runbook [-b "<body>"]. Details: cb help mem');
      if (!o.kind) throw new Error('say what it is: -k fact (system state), gotcha (a trap), rule (standing practice: Ahmed confirms), runbook (a procedure). Details: cb help mem');
      const project = a.length > 1 ? a[0] : sessionProject;
      if (!project) throw new Error('name the project (or global): cb mem add <project> "<title>" -k <kind>, or bind this pane first with cb iam <name> <project>');
      const m: any = await callFn('mem_add', { project, title: a.length > 1 ? a.slice(1).join(' ') : a[0], kind: o.kind, body: o.body ?? '',
        task_id: o.task ?? null, review: o.review ?? null, links: links(), machine: o.machine ?? null,
        tags: o.labels ? o.labels.split(',') : [], actor, propose: o.propose ?? false });
      return { out: after(m, 'added'), json: m };
    }
    if (sub === 'rule') {
      if (!a.length) throw new Error('usage: cb mem rule Q<id> ["<the rule in one line>"]   e.g. cb mem rule Q29 "Money PRs: merge on two GOs, owe the docs as a task"');
      const m: any = await callFn('mem_rule', { question: a[0], title: a.slice(1).join(' ') || null, actor });
      return { out: after(m, 'added').replace(' proposed', ` proposed from Q${m.source.question_id}`), json: m };
    }
    if (sub === 'find') {
      if (!a.length) throw new Error('usage: cb mem find "<words>" [--project <p>] [--all]');
      const q = a.join(' '), scope = o.project ?? sessionProject ?? null, include_old = !!o.all;
      const oldHint = include_old ? '' : ' (--all adds retired and replaced entries)';
      const rows: any = await callFn('mem_find', { q, project: scope, include_old });
      if (rows.length || !scope) return { out: rows.map(memLine).join('\n') || `nothing about "${q}"${oldHint}`, json: rows };
      if (o.project) return { out: `nothing about "${q}" in ${scope} (drop --project to search every project${include_old ? '' : '; --all adds retired and replaced entries'})`, json: [] };
      // #660: a session that inherited a pane binding searches that project without knowing it: widen once, and say so
      const wide = (await callFn('mem_find', { q, project: null, include_old }) as any[]).filter((m) => m.project && m.project !== scope);
      return wide.length
        ? { out: [`nothing about "${q}" in ${scope}; in other projects:`, ...wide.map((m) => `  ${m.project}: ${memLine(m)}`)].join('\n'), json: wide }
        : { out: `nothing about "${q}" in ${scope} or any other project${oldHint}`, json: [] };
    }
    if (sub === 'list') {
      const rows: any = await callFn('mem_list', { project: a[0] ?? sessionProject ?? null, kind: o.kind ?? null, include_old: !!o.all });
      return { out: rows.map(memLine).join('\n') || 'no memory here yet: cb mem add <project> "<title>" -k fact', json: rows };
    }
    if (sub === 'show') {
      if (!a.length) throw new Error('usage: cb mem show M<id>');
      const m: any = await callFn('mem_show', { id: a[0] });
      const src = Object.entries(m.source ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');
      const lk = Object.entries(m.links ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');
      return { out: [memLine(m), m.body, `${m.project ?? 'global'}${m.machine ? `, ${m.machine} only` : ''} · by ${m.created_by} ${String(m.created_at).slice(0, 10)}` +
        `${m.confirmed_by ? ` · confirmed by ${m.confirmed_by}` : ''}${src ? ` · ${src}` : ''}${lk ? ` · ${lk}` : ''}`,
        m.retired_why && `why retired: ${m.retired_why}`].filter(Boolean).join('\n'), json: m };
    }
    if (sub === 'supersede') {
      if (a.length < 2) throw new Error('usage: cb mem supersede M<id> "<new title>" [-b "<body>"]');
      const m: any = await callFn('mem_supersede', { id: a[0], title: a.slice(1).join(' '), body: o.body ?? null, actor });
      const old = String(a[0]).replace(/^m/i, '');
      return { out: m.status === 'active' ? `M${m.id} replaces M${old}: ${m.title}`
        : `M${m.id} proposed to replace M${old}: Ahmed confirms it on the Memory page; M${old} stays until then`, json: m };
    }
    if (sub === 'retire') {
      if (!a.length) throw new Error('usage: cb mem retire M<id> ["why"]');
      await callFn('mem_retire', { id: a[0], why: a.slice(1).join(' ') || null, actor });
      return { out: `M${String(a[0]).replace(/^m/i, '')} retired` };
    }
    if (sub === 'confirm')
      throw new Error('only Ahmed confirms, on the Memory page (key 9 on the board). Ask him if it matters now: cb ask');
    throw new Error(`unknown mem command "${sub ?? ''}": add, rule, find, list, show, supersede, retire. Details: cb help mem`);
  }
}

async function run(): Promise<unknown> {
  await resolveActor();
  switch (cmd) {
    case 'start':
      return { out: await start() };
    case 'tag': {
      need(2, 'tag <id> <tag>... [-<tag>]...   e.g. cb tag 42 ocr tawuniya -old');
      await guard(args[0]);
      const tags = args.slice(1);
      const now: any = await callFn('task_tag', { id: args[0], actor,
        add: tags.filter((x) => !x.startsWith('-')), remove: tags.filter((x) => x.startsWith('-')).map((x) => x.slice(1)) });
      return { out: `#${args[0].replace(/^#/, '')} tags: ${now.length ? now.join(', ') : '(none)'}`, json: now };
    }
    case 'user': {
      need(2, 'user add <name> ["Display Name"]   e.g. cb user add omar "Omar"');
      if (args[0] === 'rotate' || args[0] === 'remove')
        throw new Error(`Ahmed does this on the People page (key 7 on the board): a new link, or removing someone, is his call`);
      if (args[0] !== 'add') throw new Error(`unknown user command "${args[0]}". Run: cb user add <name> ["Display Name"]; list people with cb users`);
      // The link is the guest's login, so a session never gets it (cb.user_add returns it to the dashboard only).
      await callFn('user_add', { name: args[1], display: args[2] ?? null, actor });
      const [u] = await sql`select name, display from cb.users where name = ${args[1].trim().toLowerCase()}`;
      return { out: `added ${u.name} (${u.display}): Ahmed copies their link from the People page`, json: u };
    }
    case 'users': {
      const rows = await sql`select u.name, u.display,
        (select count(*)::int from cb.questions q where q.assigned_to = u.name and q.status = 'open') as open_questions,
        (select count(*)::int from cb.tasks t where t.assignee = u.name and t.status not in ('done','cancelled')) as open_tasks
        from cb.users u order by u.name`;
      return { out: rows.map((r: any) => `${r.name.padEnd(12)} ${r.display}: ${r.open_questions} questions, ${r.open_tasks} tasks open`).join('\n') || 'no users (cb user add omar "Omar")', json: rows };
    }
    case 'github': {
      // The GitHub watch (#1207): one cb.settings row per repo; the board server polls them (server/github.ts).
      const sub = args[0];
      if (sub === 'add' || sub === 'remove') {
        need(2, 'github add <owner/repo> [--to orch@shaltoot] [--project ihop]   or   cb github remove <owner/repo>');
        const repo = args[1], key = `github:${repo}`;
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`"${repo}" is not owner/repo, e.g. cb github add TachyHealth/iHop-Platform`);
        return await sql.begin(async (tx: any) => {
          // What the board watches, and whom it tells, is Ahmed's call: the same guard as his People and Epics pages
          await tx`select cb.dashboard_only('GitHub')`.catch(() => { throw new Error('only Ahmed adds or removes watched repos: ask him with cb ask'); });
          if (sub === 'remove') {
            if (!(await tx`delete from cb.settings where key = ${key} returning key`).length) throw new Error(`${repo} is not watched: cb github lists the repos`);
            return { out: `stopped watching ${repo}; its cards stay on the board` };
          }
          const [{ p }] = await tx`select cb.read_project(${o.project ?? 'ihop'}) as p`;
          const to = o.to ?? 'orch@shaltoot', patch = { ...(o.to ? { to } : {}), ...(o.project ? { project: p } : {}) };
          // a new repo starts now (no backfill); adding it again changes only what was given and keeps its checkpoint
          const [r] = await tx`insert into cb.settings (key, value)
            values (${key}, ${tx.json({ since: new Date().toISOString(), to, project: p, last_ok: null, last_error: null, prs: {} })})
            on conflict (key) do update set value = cb.settings.value || ${tx.json(patch)} returning value`;
          return { out: `watching ${repo}: ${r.value.to} is told, PR cards go in ${r.value.project}, events from ${r.value.since} on`, json: r.value };
        });
      }
      if (sub) throw new Error(`unknown github command "${sub}": cb github lists, cb github add <owner/repo>, cb github remove <owner/repo>`);
      const rows = await sql`select key, value from cb.settings where key like 'github:%' order by key`;
      const out = rows.map(({ key, value: v }: any) => {
        const cards = Object.entries(v.prs ?? {});
        return [`${key.slice(7)} → ${v.to} (${v.project}) · last poll ${v.last_ok ? `${dur((Date.now() - Date.parse(v.last_ok)) / 60000)} ago` : 'never'} · since ${v.since}` +
          (v.last_error ? ` · last error: ${flat(v.last_error.message)} (since ${v.last_error.at})` : ''),
          ...(cards.length ? [`  open PR cards: ${cards.map(([n, id]) => `PR #${n} → card #${id}`).join(', ')}`] : [])].join('\n');
      });
      return { out: out.join('\n') || 'no repos watched (Ahmed adds them: cb github add <owner/repo>)', json: rows.map((r: any) => ({ repo: r.key.slice(7), ...r.value })) };
    }
    case 'assign': {
      need(2, 'assign <Q12|#34> <user|ahmed>   hand a question or task to a user (ahmed takes a question back)');
      const target = args[0], to = args[1] === 'ahmed' ? null : args[1];
      if (/^q\d+$/i.test(target)) {
        await callFn('question_assign', { id: target.slice(1), to_user: to, actor });
        return { out: `Q${target.slice(1)} → ${to ?? 'ahmed'}` };
      }
      await guard(target);
      if (to && !(await sql`select 1 from cb.users where name = ${to}`).length) throw new Error(`unknown user ${to}: see cb users, or add them with cb user add ${to} "<Display Name>"`);
      await callFn('task_update', { id: target, fields: { assignee: to }, actor });
      return { out: `#${target.replace(/^#/, '')} → ${to ?? 'nobody'}` };
    }
    case 'huddles': {
      const rows: any = await callFn('huddles_list', { project: args[0] ?? sessionProject ?? null });
      const out = rows.map((h: any) => `huddle #${h.id} [${h.status}] ${h.topic}${h.task_id ? ` (task #${h.task_id})` : ''} · ${h.members.join(', ')} · ${h.messages} lines` +
        (h.summary ? `\n  outcome: ${h.summary}` : h.last ? `\n  last: ${h.last.actor}: ${h.last.summary}` : ''));
      return { out: out.join('\n') || 'no huddles', json: rows };
    }
    case 'huddle': {
      const sub = args[0];
      if (sub === 'open') {
        need(2, 'huddle open "<topic>" <session>... [-t task]   e.g. cb huddle open "Hijri dates" W3@macbook -t 59');
        if (o.task) await guard(o.task);
        const id = await callFn('huddle_open', { topic: args[1], members: args.slice(2), task: o.task ?? null, actor });
        return { out: `huddle #${id} open with ${args.slice(2).join(', ') || 'nobody yet'}; talk with: cb huddle say ${id} "..."`, json: id };
      }
      need(2, 'huddle say|add|close|show <id> ...');
      const id = args[1].replace(/^#/, '');
      if (sub === 'say') {
        need(3, 'huddle say <id> "<message>"');
        await callFn('huddle_say', { id, message: args.slice(2).join(' '), actor });
        return { out: `said in huddle #${id}` };
      }
      if (sub === 'add') {
        need(3, 'huddle add <id> <session>...');
        const added: any = await callFn('huddle_add', { id, members: args.slice(2), actor });
        return { out: `huddle #${id}: added ${added.join(', ') || 'nobody new'}`, json: added };
      }
      if (sub === 'close') {
        await callFn('huddle_close', { id, summary: args.slice(2).join(' ') || null, actor });
        return { out: `huddle #${id} closed` };
      }
      if (sub === 'show') {
        const [h] = await sql`select * from cb.huddles where id = ${Number(id)}`;
        if (!h) throw new Error(`no huddle #${id}: cb huddles lists them`);
        const lines = await sql`select at, actor, summary from cb.events where kind = 'huddle' and (data ->> 'huddle')::bigint = ${Number(id)} order by id`;
        const members = await sql`select actor from cb.huddle_members where huddle_id = ${Number(id)} order by added_at`;
        const head = `huddle #${h.id} [${h.status}] ${h.topic}${h.task_id ? ` (task #${h.task_id})` : ''} · ${h.project} · ${members.map((m: any) => m.actor).join(', ')}`;
        return { out: [head, ...lines.map((l: any) => `  ${new Date(l.at).toISOString().slice(11, 16)} ${l.actor}: ${l.summary}`)].join('\n'), json: { huddle: h, lines } };
      }
      throw new Error(`unknown huddle command "${sub}": use open, say, add, close or show, e.g. cb huddle say ${id} "..." (cb help huddle)`);
    }
    case 'tell': {
      need(2, 'tell <session> "<message>"   e.g. cb tell W2@macbook "take #19 next"');
      if (sessionProject) {
        const [t] = await sql`select project from cb.sessions where actor = ${args[0]} order by last_seen desc limit 1`;
        if (t?.project && t.project !== sessionProject)
          throw new Error(`${args[0]} works in ${t.project}; this session works in ${sessionProject}. Sessions only talk inside their project: tell one of yours (cb sessions), or ask your orchestrator to pass it on.`);
      }
      const id = await callFn('tell', { to_actor: args[0], message: args.slice(1).join(' '), actor });
      const [s] = await sql`select last_seen > now() - interval '90 seconds' as live from cb.sessions where actor = ${args[0]} order by last_seen desc limit 1`;
      return { out: `message #${id} to ${args[0]}${s?.live ? ' (relay live: delivered within seconds)' : ' (relay not live: it arrives when its relay starts, within 24h)'}`, json: id };
    }
    case 'sessions': {
      const rows: any = await callFn('sessions_overview', { project: args[0] ?? sessionProject ?? null });
      const idle = (r: any) => (r.last ? (Date.now() - +new Date(r.last.at)) / 60000 : Infinity);
      const open = rows.filter((r: any) => r.live || r.doing.length || r.queued || r.open_questions);
      const out = open.map((r: any) => {
        const head = `${r.actor} ${r.live ? 'relay live' : 'no relay'}${r.pane ? ` · ${r.pane}` : ''} · idle ${dur(idle(r))}` +
          ` · ${r.queued} queued · ${r.done_24h} done 24h${r.open_questions ? ` · ${r.open_questions} asking Ahmed` : ''}` +
          (!r.live && r.doing.length && idle(r) > 60 ? '  ⚠ holds work, gone quiet' : '');
        return [head, ...(r.doing.length ? r.doing.map((t: any) => `  #${t.id} ${t.title} [${t.status}]`) : ['  (nothing in progress)'])].join('\n');
      });
      const quiet = rows.length - open.length;
      return { out: (out.join('\n') || 'no sessions') + (quiet ? `\n(${quiet} quiet sessions hidden: no relay, nothing open)` : ''), json: rows };
    }
    case 'session': {
      need(1, 'session <name>   e.g. cb session W6@macbook');
      const who = args[0];
      const tasks = await sql`select id, status, priority, type, title, project from cb.tasks where assignee = ${who} and status not in ('done','cancelled') order by status, priority, rank`;
      const qs = await sql`select id, status, body from cb.questions where asked_by = ${who} and status in ('open','answered') order by id`;
      const ev = await sql`select at, kind, task_id, summary from cb.events where actor = ${who} order by id desc limit 10`;
      const out = [`${who}: ${tasks.length} open tasks`, ...tasks.map((t: any) => '  ' + line(t)),
        qs.length ? 'QUESTIONS' : '', ...qs.map((q: any) => `  Q${q.id} ${q.status}: ${q.body}`),
        'RECENT', ...ev.map((e: any) => `  ${new Date(e.at).toISOString().slice(5, 16).replace('T', ' ')} ${e.kind}${e.task_id ? ` #${e.task_id}` : ''}: ${String(e.summary).slice(0, 120)}`)];
      return { out: out.filter(Boolean).join('\n'), json: { tasks, questions: qs, events: ev } };
    }
    case 'broadcast': {
      need(1, 'broadcast "<message>" [--project <p>]');
      const id = await callFn('broadcast', { message: args.join(' '), project: o.project ?? null, actor });
      return { out: `broadcast #${id} sent to ${o.project ? `every ${o.project} session` : 'every session'}`, json: id };
    }
    case 'relay': {
      if (!process.env.CLAUDE_CODE_MESSAGING_SOCKET) throw new Error('no session inbox here (needs a Claude Code session, 2.1.234+). Without a relay, run cb mine and cb pending between steps');
      if (!pane) throw new Error('cb relay needs a herdr pane ($HERDR_PANE_ID). Without a relay, run cb mine and cb pending between steps');
      spawnSync(process.execPath, [join(import.meta.dirname, 'relay.ts'), ...(o.restart ? ['--restart'] : [])], { stdio: 'ignore' });
      return { out: `relay on for ${pane}@${machine()}: answers and changes to your tasks now arrive in this session` };
    }
    case 'iam': {
      need(1, 'iam <name> [project]   e.g. cb iam W1@macbook ihop');
      if (!pane) throw new Error('cb iam needs a herdr pane ($HERDR_PANE_ID); use --as <name> on each command instead');
      const p = await callFn('iam', { machine: machine(), pane, actor: args[0], project: args[1] ?? null });
      const [b] = await sql`select project from cb.sessions where machine = ${machine()} and pane = ${pane}`;
      const pack = b?.project ? packText(await callFn('mem_pack', { project: b.project, machine: machine() })) : '';
      const goals = b?.project ? goalsText(await callFn('goals_list', { project: b.project }) as any[]) : '';
      return { out: `this pane (${pane}@${machine()}) is ${p}${b?.project ? `, working on ${b.project}` : ' (no project: add one, cb iam <name> <project>)'}${pack ? `\n\n${pack}` : ''}${goals ? `\n\n${goals}` : ''}` };
    }
    case 'mem':
      return await mem();
    case 'add': {
      need(2, 'add <project> "<title>" [-s next] [-p P1]   e.g. cb add ihop "Fix Hijri month parse" -s next');
      const id = await callFn('task_add', { project: args[0], title: args.slice(1).join(' '), body: o.body ?? '',
        status: o.status ?? 'backlog', priority: o.priority ?? 'P2', labels: o.labels ? o.labels.split(',') : [],
        links: links(), assignee: o.assignee ?? null, actor, ...(o.type ? { type: o.type } : {}), ...(o.epic ? { epic: o.epic } : {}) });
      return { out: `#${id}`, json: id };
    }
    case 'bug': {
      need(2, 'bug <project> "<title>" -b "what happened, how to reproduce, expected vs actual"');
      if (!o.body?.trim()) throw new Error('describe it: -b "what happened, how to reproduce, expected vs actual"');
      await sql`select cb.read_project(${args[0]})`; // a typo errors with the known projects instead of creating one
      const id = await callFn('task_add', { project: args[0], title: args.slice(1).join(' '), body: o.body, status: 'next',
        priority: o.priority ?? 'P2', labels: o.labels ? o.labels.split(',') : [], links: links(), actor, type: 'bug' });
      const [{ project, all }] = await sql`select t.project, cb.triagers(t.project) as all from cb.tasks t where t.id = ${id}`;
      const told = all.filter((a: string) => a !== actor);
      const orch = told.some((a: string) => a === 'orch' || a.startsWith('orch@'));
      const who = told.length ? `told ${told.join(', ')}${orch ? '' : ' (no orchestrator there)'}`
        : all.length ? `you triage it: cb edit ${id} --assignee <worker>` : `no session works in ${project} yet: it waits in Next`;
      return { out: `#${id} bug filed in ${project}; ${who}`, json: { id, project, told } };
    }
    case 'move':
      need(2, 'move <id> <status> ["<note>"]');
      await guard(args[0]);
      await callFn('task_move', { id: args[0], status: args[1], note: args.slice(2).join(' ') || null, actor });
      return { out: `#${args[0].replace('#', '')} → ${args[1]}${await released(args[0])}` };
    case 'done':
      need(2, 'done <id> "<summary>" [--commit <sha>] [--pr <url>]   e.g. cb done 42 "Hijri parse fixed" --commit ab12cd3');
      await guard(args[0]);
      await callFn('task_done', { id: args[0], summary: args.slice(1).join(' '), links: links(), actor });
      return { out: `#${args[0].replace('#', '')} done${await released(args[0])}` };
    case 'block':
    case 'unblock': {
      need(1, `${cmd} <task> --by <task>   e.g. cb ${cmd} 13 --by 12`);
      if (!o.by) throw new Error(`usage: cb ${cmd} <task> --by <task>   e.g. cb ${cmd} 13 --by 12. Details: cb help ${cmd}`);
      await guard(args[0]);
      await callFn(cmd === 'block' ? 'task_block' : 'task_unblock', { task: args[0], blocker: o.by, actor });
      const [t] = await sql`select id, status from cb.tasks where id = ${Number(args[0].replace(/^#/, ''))}`;
      const by = o.by.replace(/^#/, '');
      return { out: `#${t.id} ${cmd === 'block' ? 'waits on' : 'no longer waits on'} #${by} (now ${t.status})` };
    }
    case 'goals': {
      const rows: any = await callFn('goals_list', { project: args[0] ?? sessionProject ?? null });
      return { out: goalsText(rows) || 'no active goals: Ahmed sets them on the Goals page (key 0)', json: rows };
    }
    case 'epics': {
      const rows: any = await callFn('epics_list', { project: args[0] ?? sessionProject ?? null });
      return { out: rows.map((e: any) => `E${e.id} [${e.status}] ${e.title} · ${e.project} · ${e.finished} of ${e.total} done`).join('\n')
        || 'no epics yet: Ahmed creates them on the Epics page (key 8)', json: rows };
    }
    case 'edit': {
      need(1, 'edit <id> --title/--body/--priority/--assignee/--project/--type/--epic   e.g. cb edit 42 --priority P1');
      await guard(args[0]);
      const fields: Record<string, unknown> = {};
      for (const k of ['title', 'body', 'priority', 'assignee', 'project', 'type', 'epic'] as const) if (o[k] !== undefined) fields[k] = o[k];
      if (o.labels) fields.labels = o.labels.split(',');
      const l = links(); if (Object.keys(l).length) fields.links = l;
      await callFn('task_update', { id: args[0], fields, actor });
      return { out: `#${args[0].replace('#', '')} updated` };
    }
    case 'log':
      need(2, 'log <task id> "<what happened>"   e.g. cb log 130 "SC64 graded 27/32"');
      // `cb log 130 "..."` means task #130 (sessions kept typing it), not a project named "130"
      if (/^#?\d+$/.test(args[0]) && !o.task) {
        const [t] = await sql`select project from cb.tasks where id = ${Number(args[0].replace('#', ''))}`;
        if (!t) throw new Error(`no task #${args[0].replace('#', '')}: check the id (cb mine, cb brief). A project note is cb log <project> "..."`);
        o.task = args[0].replace('#', '');
        args[0] = t.project;
      }
      await guard(o.task);
      await callFn('log', { project: args[0], summary: args.slice(1).join(' '), task_id: o.task ?? null, actor });
      return { out: 'logged' };
    case 'next': {
      const project = args[0] ?? sessionProject;
      if (!project) throw new Error('no project: say which (cb next ihop) or bind this session once (cb iam <name> <project>)');
      if (sessionProject) {
        const [{ p }] = await sql`select cb.resolve(${project}) as p`;
        if (p !== sessionProject) throw new Error(`this session works in ${sessionProject}; ${p}'s work is for ${p}'s sessions. Run: cb next (takes from ${sessionProject})`);
      }
      const rows: any = await callFn('task_claim', { project, actor });
      if (!rows.length) return { out: 'nothing to claim', json: null };
      const t = rows[0];
      return { out: `${line(t)}${t.body ? '\n\n' + t.body : ''}`, json: t };
    }
    case 'show': {
      need(1, 'show <task id>   e.g. cb show 42');
      if (!/^#?\d{1,15}$/.test(args[0])) throw new Error(`"${args[0]}" is not a task id: give the number, e.g. cb show 42`);
      const n = Number(args[0].replace('#', ''));
      const [t] = await sql`select * from cb.tasks where id = ${n}`;
      if (!t) throw new Error(`no task #${n}: check the id (cb mine, cb brief)`);
      const notes = await sql`select at, actor, summary from cb.events where task_id = ${n} and kind in ('note', 'done') order by id desc limit 10`;
      const goals = await sql`select g.id, g.title, g.status from cb.goal_tasks gt join cb.goals g on g.id = gt.goal_id
        where gt.task_id = ${n} and gt.state = 'in' and g.status <> 'done' order by g.status, g.rank`;
      return { out: [line(t), ...goals.map((g: any) => `in goal G${g.id} ${flat(g.title)}${g.status === 'paused' ? ' [paused]' : ': comes right after P0'}`),
        t.body && `\n${flat(t.body)}`, notes.length && `\nNOTES (newest first)`,
        ...notes.map((e: any) => `  ${new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')} ${e.actor}: ${flat(e.summary)}`)]
        .filter(Boolean).join('\n'), json: { ...t, notes } };
    }
    case 'mine': {
      const rows: any = await callFn('mine', { actor });
      return { out: rows.length ? rows.map(line).join('\n') : 'no tasks assigned to ' + actor, json: rows };
    }
    case 'ask': {
      need(2, 'ask <project> "<question>" -o "<Label (Recommended)>=<why>" -o "<Label>=<tradeoff>"');
      if (!o.option && !o.free)
        throw new Error('give Ahmed options to click: -o "Label (Recommended)=why" -o "Label=tradeoff" (2-4 of them). ' +
          'Only a question with no possible choices (a fact, a URL, a name) goes as --free.');
      if (o.if && !o.after) throw new Error('--if needs --after: name the question whose answer it waits for, e.g. cb ask <project> "<q>" -o ... --after Q12 --if "Yes"');
      const reply_to = replyTo();
      const id = await callFn('ask', { project: args[0], body: args.slice(1).join(' '), options: o.option ? options() : null,
        multi: !!o.multi, blocking: !!o.blocking, task_id: o.task ?? null, context: o.context ?? null, reply_to, actor, to_user: o.to ?? null,
        parent: o.after ?? null, if_answer: o.if ?? null });
      const [f] = o.after ? await sql`select parent_id, if_answer from cb.questions where id = ${Number(id)}` : [];
      // #550: without --reply-to the answer goes to the asking name; with no live relay on it, it waits in cb pending.
      if (!o['reply-to']) {
        const live = sql`last_seen > now() - interval '90 seconds'`; // same 90s as cb.sessions_overview
        const [r] = await sql`select exists(select 1 from cb.sessions where actor = ${actor} and ${live}) as live,
          (select actor from cb.sessions where machine = ${machine()} and pane = ${pane} and ${live}) as mine`;
        if (!r.live) console.error(`warning: no relay listens on ${actor}, so the answer will wait in cb pending --as ${actor}` +
          (r.mine && r.mine !== actor ? `. This pane's relay is ${r.mine}: ask without --as, or add --reply-to` : ''));
      }
      return { out: (f ? `Q${id} posted as a follow-up to Q${f.parent_id}: ` +
          (f.if_answer ? `it opens only if Q${f.parent_id} is answered "${f.if_answer}", else it is skipped` : `it opens once Q${f.parent_id} is answered`) +
          ' — keep working; its answer arrives like any other'
        : `Q${id} posted — keep working; the answer arrives in this session by itself once \`cb relay\` is on, else via \`cb pending\``) +
        (o.free ? `\nPosted with --free: Ahmed must type the answer. If he could pick instead (yes/no, approve?, A or B, who does it), run cb withdraw Q${id} and ask again with -o options (cb help ask).` : ''), json: id };
    }
    case 'pending': {
      const rows: any = await callFn('answers_pending', { project: args[0] ?? sessionProject });
      const ids = rows.map((q: any) => q.parent_id).filter(Boolean);
      const parents = new Map((ids.length ? await sql`select id, body, answer from cb.questions where id in ${sql(ids)}` : []).map((p: any) => [p.id, p]));
      return { out: rows.length ? rows.map((q: any) => { const p: any = parents.get(q.parent_id);
        if (q.status === 'sent_back') { const by = q.sent_back.by === 'ahmed' ? 'Ahmed' : `${q.sent_back.by} (not Ahmed)`;
          return `Q${q.id} sent back by ${by} to ${q.asked_by}: ${flat(backWhy(q.sent_back.reason, q.sent_back.note?.slice(0, 500)))}` +
            `\n  asked: ${flat(q.body)}\n  rewrite it: ${reaskHint(q.id)}`; }
        return `Q${q.id} → ${q.asked_by}${q.reply_to?.pane ? ` (pane ${q.reply_to.pane}@${q.reply_to.machine})` : ''}` +
          `${p ? `\n  follow-up to Q${p.id} (answered ${flat(p.answer)}): ${flat(p.body)}` : ''}\n  asked: ${flat(q.body)}\n  answer: ${flat(q.answer)}`; }).join('\n')
        : 'no answers waiting', json: rows };
    }
    case 'reask': {
      need(1, 'reask Q<id> ["<new question>"] [-o "<Label>=<why>" ... | --free] [--multi] [-c "<context>"]');
      const id = args[0].replace(/^q/i, '');
      await callFn('reask', { id, body: args.slice(1).join(' ') || null, options: o.option ? options() : null, free: !!o.free,
        multi: o.multi ? true : null, context: o.context ?? null, actor });
      const [w] = await sql`select u.display from cb.questions q join cb.users u on u.name = q.assigned_to where q.id = ${Number(id)}`;
      return { out: `Q${id} rewritten and back ${w ? `with ${w.display}` : "on Ahmed's board"} — keep working; the answer arrives like any other` };
    }
    case 'delivered':
      need(1, 'delivered <qid> [session]');
      await callFn('answer_delivered', { id: args[0].replace(/^q/i, ''), delivered_to: args[1] ?? null, actor });
      return { out: `Q${args[0].replace(/^q/i, '')} delivered` };
    case 'withdraw':
      need(1, 'withdraw <qid>');
      await callFn('withdraw', { id: args[0].replace(/^q/i, ''), actor });
      return { out: `Q${args[0].replace(/^q/i, '')} withdrawn` };
    case 'reply': {
      need(2, 'reply A<id> "<text>" [--done]   e.g. cb reply A12 "SC64 graded 27/32" --done');
      const id = args[0].replace(/^a/i, '');
      await callFn('ask_reply', { id: args[0], message: args.slice(1).join(' '), done: !!o.done, actor });
      return { out: `replied to A${id}${o.done ? `; A${id} closed` : ': Ahmed reads it on Today (more: cb reply again; the last one with --done)'}` };
    }
    case 'asks': {
      if (args[0] === 'add') { // #951: what Ahmed asked in this terminal, onto the board so the reply lands on Today
        need(2, 'asks add "<what Ahmed asked you>" [-t <task>]   e.g. cb asks add "Why is SC64 at 27/32?"');
        const id = await callFn('ask_record', { body: args.slice(1).join(' '), task: o.task ?? null, project: sessionProject ?? null, actor });
        return { out: `A${id} recorded (asked in your terminal): reply on the board with cb reply A${id} "<reply>" (--done with the final one)`, json: id };
      }
      const rows: any = await callFn('asks_list', { to_actor: actor, include_closed: false });
      const hm = (t: string) => new Date(t).toISOString().slice(11, 16);
      return { out: rows.map((a: any) => [
        `A${a.id} [${a.state}${a.late ? ', late' : ''}] ${a.from_terminal ? 'asked in your terminal, recorded by you' : 'from Ahmed'} ${dur((Date.now() - +new Date(a.created_at)) / 60000)} ago${a.task_id ? ` · task #${a.task_id}` : ''}`,
        ...a.lines.map((l: any) => `  ${hm(l.at)} ${l.actor === 'ahmed' ? 'Ahmed' : l.actor}: ${flat(l.text)}`),
        `  → cb reply A${a.id} "<reply>"   (--done with the final one closes it)`].join('\n')).join('\n') || `no open asks for ${actor}`, json: rows };
    }
    case 'tick': {
      const project = args[0] ?? sessionProject;
      if (!project) throw new Error('no project: say which (cb tick ihop) or bind this session once (cb iam <name> <project>)');
      return await tick(project, actor);
    }
    case 'lock': {
      const [sub, name] = args;
      const show = (l: any) => `lock ${l.name}: ${l.holder ?? 'nobody'} holds it ${dur((Date.now() - +new Date(l.held_at)) / 60000)}${l.queue.length ? `, queue ${l.queue.join(', ')}` : ''}`;
      if (sub === 'queue') {
        const rows: any = await callFn('lock_queue', { name: name ?? null });
        return { out: rows.map(show).join('\n') || 'no locks held', json: rows };
      }
      need(2, 'lock take|release <name>   e.g. cb lock take db');
      if (sub === 'take') {
        const l: any = await callFn('lock_take', { name, actor });
        const pos = l.queue.indexOf(actor) + 1;
        return { out: l.holder === actor ? `you hold lock ${l.name}`
          : `lock ${l.name} is held by ${l.holder} (${dur((Date.now() - +new Date(l.held_at)) / 60000)}); you are #${pos} in the queue: a message tells you when it is yours (exit 2 = queued, not held)`, json: l,
          code: l.holder === actor ? 0 : 2 }; // #741: scripts read exit 0 as "I hold it"
      }
      if (sub === 'release') {
        const next: any = await callFn('lock_release', { name, actor, force: !!o.force });
        const n = name.trim().toLowerCase();
        const [l]: any = await callFn('lock_queue', { name: n });
        return { out: `released lock ${n}; ${next ? `${next} holds it now` : l ? `${l.holder} holds it` : 'it is free'}`, json: next };
      }
      throw new Error(`unknown lock command "${sub}": take, release, queue`);
    }
    case 'brief': {
      const b: any = await callFn('brief', { project: args[0] ?? sessionProject, tag: o.tag ?? null, ...(o.type ? { type: o.type } : {}) });
      // the same pack cb iam prints, with this machine's own entries (cb.brief can't know the machine)
      if (b.memory && (args[0] ?? sessionProject)) b.memory = await callFn('mem_pack', { project: args[0] ?? sessionProject, machine: machine() });
      if (o.json) return { json: b };
      printBrief(b);
      return {};
    }
    case undefined: case 'help': {
      const page = help(args[0]);
      if (page === null) throw new Error(unknownHelp(args[0]));
      return { out: page };
    }
    default:
      throw new Error(`unknown command "${cmd}". Commands: ${Object.keys(COMMANDS).join(', ')}. Run: cb start (what to do next) or cb help (the manual)`);
  }
}

// The schema's errors name the problem; these add the command that fixes it.
const HINTS: [RegExp, string][] = [
  [/task #\d+ not found/, "check the id: cb mine lists yours, cb brief your project's"],
  [/question Q\d+ not found/, 'check the id: cb brief lists open questions, cb pending answered ones'],
  [/^unknown project /, 'bind to one of those (cb iam <name> <project>), or start a new one: cb help project'],
  [/huddle #\d+ is closed/, 'open a new one: cb huddle open "<topic>" <session>...'],
];
/** Every error ends with something to run. */
function actionable(m: string) {
  for (const [re, hint] of HINTS) if (re.test(m)) m += `. ${hint}`;
  if (/\bcb [a-z]/.test(m) || /keep working/.test(m)) return m;
  return `${m}. Run: cb help${cmd && Object.hasOwn(COMMANDS, cmd) ? ` ${cmd}` : ''}`;
}

async function main() {
  if (o.help) { console.log(help(cmd) ?? help()); return; }
  let r: any;
  try {
    r = await run();
  } catch (e: any) {
    // cb start is advice: it always exits 0 and never starts Postgres (e.g. the Mac while this PC sleeps)
    if (cmd === 'start') { console.log(`board unreachable: keep working and register this later. Retry: cb start (${e?.code ?? e?.message ?? e})`); return; }
    const host = new URL(databaseUrl()).hostname;
    const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
    const network = ['ECONNREFUSED', 'ETIMEDOUT', 'CONNECT_TIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND'].includes(e?.code);
    if (!network) throw e;
    // A remote board (another machine) can't be started from here: say so and let the session carry on.
    if (!local) throw new Error(`board unreachable at ${host} (${e.code}). The board machine may be asleep: keep working and register this later.`);
    if (e.code !== 'ECONNREFUSED') throw e;
    (await import('../db/pg.ts')).ensurePg();
    r = await run();
  }
  if (o.json && 'json' in r) console.log(JSON.stringify(r.json, null, 2));
  else if (r.out) console.log(r.out);
  if (r.code) process.exitCode = r.code;
}

try {
  await main();
} catch (e: any) {
  console.error(`cb: ${actionable(String(e?.message ?? e))}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 1 });
}
