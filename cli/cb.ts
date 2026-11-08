// cb — Claude Board CLI. Talks to Postgres directly (works without the web server).
import { parseArgs } from 'node:util';
import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { callFn } from '../server/rpc.ts';
import { sql, databaseUrl, machine } from '../server/db.ts';

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
  cb ask <project> "question" [-o "Label=why"]... [--multi] [-c "context"] [--blocking -t id]
  cb pending [project]                       answered questions to deliver (orchestrator)
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
  multi: { type: 'boolean' }, blocking: { type: 'boolean' }, context: { type: 'string', short: 'c' },
  'reply-to': { type: 'string' }, restart: { type: 'boolean' }, tag: { type: 'string' },
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
  sec('WAITING ON AHMED', b.open_questions, (q) => `Q${q.id}${q.blocking ? ' [blocking]' : ''} ${q.body} · ${q.project}`);
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
      const reply_to = replyTo();
      const id = await callFn('ask', { project: args[0], body: args.slice(1).join(' '), options: o.option ? options() : null,
        multi: !!o.multi, blocking: !!o.blocking, task_id: o.task ?? null, context: o.context ?? null, reply_to, actor });
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
