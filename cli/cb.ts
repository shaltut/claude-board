// cb — Claude Board CLI. Talks to Postgres directly (works without the web server).
import { parseArgs } from 'node:util';
import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { callFn } from '../server/rpc.ts';
import { tick, dur } from './tick.ts';
import { sql, databaseUrl, machine, dotenv } from '../server/db.ts';

const HELP = `cb — Claude Board (http://localhost:4747)

  cb broadcast "<message>" [--project p]     a message to every session (or one project's), pushed by relays
  cb relay [--restart]                       push answers, task changes, broadcasts and new work into this session
  cb iam <name> [project]                    name this session once (e.g. W1@macbook ihop); later commands act as it, in that project
  cb tag <id> <tag>... [-<tag>]...           tag work streams (ocr, tawuniya); -tag removes
  cb brief [project] [--tag t]               what's in progress / next / blocked / waiting
  cb next [project]                          claim the top task in Next (sets in_progress + you)
  cb mine                                    your tasks (re-check between steps; obey moves/cancels)
  cb add <project> "<title>" [-s next] [-p P1] [-b body] [-l a,b] [--link k=v]
  cb move <id> <status> ["note"]             status: backlog next in_progress blocked review done cancelled
  cb done <id> "summary" [--pr x] [--commit x] [--branch x] [--link k=v]
  cb edit <id> [--title x] [--body x] [--priority P1] [--assignee x] [--project x]
  cb log <project> "what happened" [-t id]
  cb ask <project> "question" -o "Label (Recommended)=why" -o "Label=tradeoff"... [--multi] [-c "context"] [--blocking -t id] [--free: no options]
  cb tell <session> "<msg>"                  message one session; it arrives in that session by itself
  cb huddle open "<topic>" <session>... [-t id]   discussion group with other sessions (same project)
  cb huddle say|add|close|show <id> ...      talk / add members / close "summary" / read the thread
  cb huddles [project]                       open huddles (and the last week's closed ones)
  cb user add <name> ["Display"] / cb users   people who answer through a link (Omar, Iman)
  cb assign <Q12|#34> <user|ahmed>           hand a question or task to a user; ask --to <user> does it at ask time
  cb sessions [project]                      every session: relay, what it holds, who went quiet (orchestrator)
  cb session <name>                          one session: open tasks, questions, last 10 actions
  cb pending [project]                       answered questions to deliver (orchestrator)
  cb tick [project]                          the actions due now, ranked, one command each; silent when nothing is (orchestrator)
  cb lock take|release <name> / cb lock queue [name]   shared locks (the DB test lock): take queues you; release hands it on
  cb lock release <name> --force             take a lock off a dead holder (logged; the holder is told)
  cb delivered <qid> [session]               mark an answer delivered (unblocks its task)
  cb withdraw <qid>
  ask on behalf of a worker (orchestrator): add --as <worker> --reply-to <machine>:<pane>

  --as <name>   actor (default: $CB_ACTOR, else <pane>@<host>)     --json   raw JSON output`;

const OPTIONS = {
  as: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  status: { type: 'string', short: 's' }, priority: { type: 'string', short: 'p' },
  body: { type: 'string', short: 'b' }, labels: { type: 'string', short: 'l' },
  link: { type: 'string', multiple: true }, pr: { type: 'string' }, commit: { type: 'string' }, branch: { type: 'string' },
  title: { type: 'string' }, assignee: { type: 'string' }, project: { type: 'string' },
  task: { type: 'string', short: 't' }, option: { type: 'string', short: 'o', multiple: true },
  multi: { type: 'boolean' }, blocking: { type: 'boolean' }, free: { type: 'boolean' }, to: { type: 'string' }, context: { type: 'string', short: 'c' },
  'reply-to': { type: 'string' }, restart: { type: 'boolean' }, tag: { type: 'string' }, force: { type: 'boolean' },
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
  console.error(`cb: ${name ? `unknown option ${name}` : e?.message}. Run \`cb help\` for valid options.`);
  process.exit(1);
}
const o: any = Object.fromEntries(Object.entries(parsed.values).map(([k, v]) => [k, unmark(v)]));
const pos: string[] = parsed.positionals.map(unmark);

const pane = process.env.HERDR_PANE_ID || '';
// --as, then $CB_ACTOR, then the name this pane gave itself with `cb iam`, then <pane>@<host>.
let actor = o.as || process.env.CB_ACTOR || `${pane || 'session'}@${hostname()}`;
const explicitActor = !!(o.as || process.env.CB_ACTOR);
const [cmd, ...args] = pos;

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
  if (args.length < n) throw new Error(`usage: cb ${usage}`);
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
  `#${t.id} [${t.status ?? ''}] ${t.priority} ${t.title}${t.labels?.length ? ` {${t.labels.join(', ')}}` : ''}${t.assignee ? ` (${t.assignee})` : ''} · ${t.project}`.replace(' [] ', ' ');

function printBrief(b: any) {
  const sec = (name: string, rows: any[], fmt: (r: any) => string) => {
    console.log(`${name} (${rows.length})`);
    for (const r of rows) console.log('  ' + fmt(r));
  };
  sec('IN PROGRESS', b.in_progress, line);
  sec('NEXT (take with `cb next`)', b.next, line);
  sec('BLOCKED', b.blocked, (t) => `${line(t)}${t.blocked_on ? ` — on Q${t.blocked_on}` : ''}`);
  sec('REVIEW', b.review, line);
  sec('WAITING ON AHMED', b.open_questions, (q) => `Q${q.id}${q.blocking ? ' [blocking]' : ''} ${q.body}${q.assigned_to ? ` (for ${q.assigned_to})` : ''} · ${q.project}`);
  sec('BROADCASTS (24h)', b.broadcasts ?? [], (x) => `${x.actor}${x.project ? ` to ${x.project}` : ' to everyone'}: ${x.summary}`);
  sec('ANSWERED — DELIVER THESE', b.answered_pending, (q) =>
    `Q${q.id} → ${q.asked_by}${q.reply_to?.pane ? ` (pane ${q.reply_to.pane}@${q.reply_to.machine})` : ''}: ${q.answer}`);
}

/** Projects are namespaces: a session bound to one project never changes another project's tasks. */
async function guard(id: string | undefined) {
  const n = Number(String(id ?? '').replace(/^#/, ''));
  if (!sessionProject || !Number.isInteger(n)) return;
  const [t] = await sql`select project from cb.tasks where id = ${n}`;
  if (t && t.project !== sessionProject)
    throw new Error(`#${n} is in ${t.project}; this session works in ${sessionProject}. Check the id; only ${t.project}'s own sessions change it.`);
}

async function run(): Promise<unknown> {
  await resolveActor();
  switch (cmd) {
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
      if (args[0] !== 'add') throw new Error('user add <name> ["Display Name"]');
      const token: any = await callFn('user_add', { name: args[1], display: args[2] ?? null });
      const [u] = await sql`select name, display from cb.users where token = ${token}`;
      const base = (process.env.CB_PUBLIC_URL || dotenv('PUBLIC_URL') || 'http://localhost:4747').replace(/\/$/, '');
      return { out: `${u.display}'s link: ${base}/?u=${token}
Send it privately: anyone with it can answer ${u.display}'s questions.`, json: { ...u, token } };
    }
    case 'users': {
      const rows = await sql`select u.name, u.display,
        (select count(*)::int from cb.questions q where q.assigned_to = u.name and q.status = 'open') as open_questions,
        (select count(*)::int from cb.tasks t where t.assignee = u.name and t.status not in ('done','cancelled')) as open_tasks
        from cb.users u order by u.name`;
      return { out: rows.map((r: any) => `${r.name.padEnd(12)} ${r.display}: ${r.open_questions} questions, ${r.open_tasks} tasks open`).join('\n') || 'no users (cb user add omar "Omar")', json: rows };
    }
    case 'assign': {
      need(2, 'assign <Q12|#34> <user|ahmed>   hand a question or task to a user (ahmed takes a question back)');
      const target = args[0], to = args[1] === 'ahmed' ? null : args[1];
      if (/^q\d+$/i.test(target)) {
        await callFn('question_assign', { id: target.slice(1), to_user: to, actor });
        return { out: `Q${target.slice(1)} → ${to ?? 'ahmed'}` };
      }
      await guard(target);
      if (to && !(await sql`select 1 from cb.users where name = ${to}`).length) throw new Error(`unknown user ${to}: see cb users`);
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
        if (!h) throw new Error(`no huddle #${id}`);
        const lines = await sql`select at, actor, summary from cb.events where kind = 'huddle' and (data ->> 'huddle')::bigint = ${Number(id)} order by id`;
        const members = await sql`select actor from cb.huddle_members where huddle_id = ${Number(id)} order by added_at`;
        const head = `huddle #${h.id} [${h.status}] ${h.topic}${h.task_id ? ` (task #${h.task_id})` : ''} · ${h.project} · ${members.map((m: any) => m.actor).join(', ')}`;
        return { out: [head, ...lines.map((l: any) => `  ${new Date(l.at).toISOString().slice(11, 16)} ${l.actor}: ${l.summary}`)].join('\n'), json: { huddle: h, lines } };
      }
      throw new Error(`unknown huddle command "${sub}": open, say, add, close, show`);
    }
    case 'tell': {
      need(2, 'tell <session> "<message>"   e.g. cb tell W2@macbook "take #19 next"');
      if (sessionProject) {
        const [t] = await sql`select project from cb.sessions where actor = ${args[0]} order by last_seen desc limit 1`;
        if (t?.project && t.project !== sessionProject)
          throw new Error(`${args[0]} works in ${t.project}; this session works in ${sessionProject}. Sessions only talk inside their project.`);
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
      const tasks = await sql`select id, status, priority, title, project from cb.tasks where assignee = ${who} and status not in ('done','cancelled') order by status, priority, rank`;
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
      if (!process.env.CLAUDE_CODE_MESSAGING_SOCKET) throw new Error('no session inbox here: run cb relay from a Claude Code session (2.1.234+)');
      if (!pane) throw new Error('cb relay needs a herdr pane ($HERDR_PANE_ID)');
      spawnSync(process.execPath, [join(import.meta.dirname, 'relay.ts'), ...(o.restart ? ['--restart'] : [])], { stdio: 'ignore' });
      return { out: `relay on for ${pane}@${machine()}: answers and changes to your tasks now arrive in this session` };
    }
    case 'iam': {
      need(1, 'iam <name> [project]   e.g. cb iam W1@macbook ihop');
      if (!pane) throw new Error('cb iam needs a herdr pane ($HERDR_PANE_ID); use --as <name> on each command instead');
      const p = await callFn('iam', { machine: machine(), pane, actor: args[0], project: args[1] ?? null });
      const [b] = await sql`select project from cb.sessions where machine = ${machine()} and pane = ${pane}`;
      return { out: `this pane (${pane}@${machine()}) is ${p}${b?.project ? `, working on ${b.project}` : ' (no project: add one, cb iam <name> <project>)'}` };
    }
    case 'add': {
      need(2, 'add <project> "<title>"');
      const id = await callFn('task_add', { project: args[0], title: args.slice(1).join(' '), body: o.body ?? '',
        status: o.status ?? 'backlog', priority: o.priority ?? 'P2', labels: o.labels ? o.labels.split(',') : [],
        links: links(), assignee: o.assignee ?? null, actor });
      return { out: `#${id}`, json: id };
    }
    case 'move':
      need(2, 'move <id> <status> ["note"]');
      await guard(args[0]);
      await callFn('task_move', { id: args[0], status: args[1], note: args.slice(2).join(' ') || null, actor });
      return { out: `#${args[0].replace('#', '')} → ${args[1]}` };
    case 'done':
      need(2, 'done <id> "summary"');
      await guard(args[0]);
      await callFn('task_done', { id: args[0], summary: args.slice(1).join(' '), links: links(), actor });
      return { out: `#${args[0].replace('#', '')} done` };
    case 'edit': {
      need(1, 'edit <id> --title/--body/--priority/--assignee/--project');
      await guard(args[0]);
      const fields: Record<string, unknown> = {};
      for (const k of ['title', 'body', 'priority', 'assignee', 'project'] as const) if (o[k] !== undefined) fields[k] = o[k];
      if (o.labels) fields.labels = o.labels.split(',');
      const l = links(); if (Object.keys(l).length) fields.links = l;
      await callFn('task_update', { id: args[0], fields, actor });
      return { out: `#${args[0].replace('#', '')} updated` };
    }
    case 'log':
      need(2, 'log <project> "summary"');
      await guard(o.task);
      await callFn('log', { project: args[0], summary: args.slice(1).join(' '), task_id: o.task ?? null, actor });
      return { out: 'logged' };
    case 'next': {
      const project = args[0] ?? sessionProject;
      if (!project) throw new Error('no project: say which (cb next ihop) or bind this session once (cb iam <name> <project>)');
      if (sessionProject) {
        const [{ p }] = await sql`select cb.resolve(${project}) as p`;
        if (p !== sessionProject) throw new Error(`this session works in ${sessionProject}; ${p}'s work is for ${p}'s sessions`);
      }
      const rows: any = await callFn('task_claim', { project, actor });
      if (!rows.length) return { out: 'nothing to claim', json: null };
      const t = rows[0];
      return { out: `${line(t)}${t.body ? '\n\n' + t.body : ''}`, json: t };
    }
    case 'mine': {
      const rows: any = await callFn('mine', { actor });
      return { out: rows.length ? rows.map(line).join('\n') : 'no tasks assigned to ' + actor, json: rows };
    }
    case 'ask': {
      need(2, 'ask <project> "question"');
      if (!o.option && !o.free)
        throw new Error('give Ahmed options to click: -o "Label (Recommended)=why" -o "Label=tradeoff" (2-4 of them). ' +
          'Only a question with no possible choices (a fact, a URL, a name) goes as --free.');
      const reply_to = replyTo();
      const id = await callFn('ask', { project: args[0], body: args.slice(1).join(' '), options: o.option ? options() : null,
        multi: !!o.multi, blocking: !!o.blocking, task_id: o.task ?? null, context: o.context ?? null, reply_to, actor, to_user: o.to ?? null });
      return { out: `Q${id} posted — keep working; the answer arrives in this session by itself once \`cb relay\` is on, else via \`cb pending\``, json: id };
    }
    case 'pending': {
      const rows: any = await callFn('answers_pending', { project: args[0] ?? sessionProject });
      return { out: rows.length ? rows.map((q: any) =>
        `Q${q.id} → ${q.asked_by}${q.reply_to?.pane ? ` (pane ${q.reply_to.pane}@${q.reply_to.machine})` : ''}\n  asked: ${q.body}\n  answer: ${q.answer}`).join('\n')
        : 'no answers waiting', json: rows };
    }
    case 'delivered':
      need(1, 'delivered <qid> [session]');
      await callFn('answer_delivered', { id: args[0].replace(/^q/i, ''), delivered_to: args[1] ?? null, actor });
      return { out: `Q${args[0].replace(/^q/i, '')} delivered` };
    case 'withdraw':
      need(1, 'withdraw <qid>');
      await callFn('withdraw', { id: args[0].replace(/^q/i, ''), actor });
      return { out: `Q${args[0].replace(/^q/i, '')} withdrawn` };
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
          : `lock ${l.name} is held by ${l.holder} (${dur((Date.now() - +new Date(l.held_at)) / 60000)}); you are #${pos} in the queue: a message tells you when it is yours`, json: l };
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
      const b = await callFn('brief', { project: args[0] ?? sessionProject, tag: o.tag ?? null });
      if (o.json) return { json: b };
      printBrief(b);
      return {};
    }
    case undefined: case 'help':
      return { out: HELP };
    default:
      throw new Error(`unknown command "${cmd}". Run \`cb help\` for the commands.`);
  }
}

async function main() {
  if (o.help) { console.log(HELP); return; }
  let r: any;
  try {
    r = await run();
  } catch (e: any) {
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
}

try {
  await main();
} catch (e: any) {
  console.error(`cb: ${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 1 });
}
