// cb — Agents Board CLI. Talks to Postgres directly (works without the web server).
import { parseArgs } from 'node:util';
import { hostname, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { callFn, useDb } from '../server/rpc.ts';
import { tick, dur } from './tick.ts';
import { sql as direct, databaseUrl, machine, dotenv } from '../server/db.ts';
import { openBridge, seatKey } from './bridge.ts';
import { withConnectRetry, neverSent, ranWords, checkFirst, onlyReads } from './connect-retry.ts';
import { getAdapter } from './agents/index.ts';
import { readClaudeEndpoint, socketExists } from './agents/claude.ts';
import { squadUp } from './squad-up.ts';
import { squadTrust } from './squad-trust.ts';
import { modelDrift, squadShow } from './squad-show.ts';
import { makeLister, modelsShow, reportModels } from './models.ts';
import { iamArgs } from './iam-args.ts';
import { titleBody } from './title-body.ts';
import { faultHook, commandIndex } from './fault-hook.ts';
import { faultsCmd } from './faults.ts';
import { triageCmd } from './triage.ts';
import { stageWordsFor } from './stage-words.ts';
import { splitRunArgs, runCmd, jobsCmd, endedCmd, jobCmd } from './jobs.ts';
import { usageCmd } from './usage.ts';
import { cardBlock, resumeText } from './resume-text.ts';
import { help, unknownHelp, unknownCommand, COMMANDS, flagsOf, backWhy, reaskHint, flat, namesCommand } from './help.ts';
import { doctorCmd } from './doctor.ts';
import { startedAs } from './started-as.ts';
import { needAddress, updateCheck } from './update.ts';
import { askSchema, install, rollback } from './update-install.ts';

const OPTIONS = {
  as: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  status: { type: 'string', short: 's' }, priority: { type: 'string', short: 'p' },
  body: { type: 'string', short: 'b' }, labels: { type: 'string', short: 'l' },
  link: { type: 'string', multiple: true }, pr: { type: 'string' }, commit: { type: 'string' }, branch: { type: 'string' },
  title: { type: 'string' }, assignee: { type: 'string' }, project: { type: 'string' },
  task: { type: 'string', short: 't' }, option: { type: 'string', short: 'o', multiple: true }, image: { type: 'string', short: 'i', multiple: true },
  multi: { type: 'boolean' }, blocking: { type: 'boolean' }, free: { type: 'boolean' }, to: { type: 'string' }, context: { type: 'string', short: 'c' },
  'reply-to': { type: 'string' }, restart: { type: 'boolean' }, tag: { type: 'string' }, type: { type: 'string' }, force: { type: 'boolean' },
  epic: { type: 'string' }, by: { type: 'string' }, after: { type: 'string' }, if: { type: 'string' },
  area: { type: 'string' }, role: { type: 'string' }, model: { type: 'string' }, file: { type: 'string', short: 'f' },
  budget: { type: 'string' }, max: { type: 'string' },
  kind: { type: 'string', short: 'k' }, review: { type: 'string' }, machine: { type: 'string' }, all: { type: 'boolean' }, propose: { type: 'boolean' }, done: { type: 'boolean' }, approved: { type: 'boolean' }, stage: { type: 'string' }, why: { type: 'string' }, admin: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
  sha: { type: 'string' }, card: { type: 'string' }, wait: { type: 'boolean' }, tail: { type: 'string' }, once: { type: 'boolean' },
  repo: { type: 'string' }, agent: { type: 'string' }, 'cards-in': { type: 'string' }, notes: { type: 'boolean' }, since: { type: 'string' }, overwrite: { type: 'boolean' },
  ended: { type: 'boolean' }, mine: { type: 'boolean' },
  root: { type: 'string' }, manifest: { type: 'string' }, check: { type: 'boolean' }, from: { type: 'string' }, rollback: { type: 'boolean' },
} as const;

// Text like "-5% latency" is text, not a flag: only --name, --name=x and -x look like options.
const TEXT = '\u0001';
const isFlag = (a: string) => /^--[a-z][a-z-]*(=.*)?$/.test(a) || /^-[a-zA-Z]$/.test(a);
const unmark = (v: any): any => typeof v === 'string' ? v.replace(TEXT, '') : Array.isArray(v) ? v.map(unmark) : v;
// #4535: a run that fails, retries or is slow leaves one line in this machine's fault log (cli/fault-hook.ts). It
// writes only at exit and never changes the exit code or the output.
const fault = faultHook(process.argv.slice(2), () => OPTIONS, () => sql);

// cb run <recipe> --<param> <value>...: the free --<param> flags are split out before parseArgs, which would refuse them
const argv = process.argv.slice(2);
const cmdPos = commandIndex(argv, OPTIONS);
const split = argv[cmdPos] === 'run' ? splitRunArgs(argv.slice(cmdPos + 1), new Set(Object.keys(OPTIONS))) : null;
const runParams = split?.params ?? {};
let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, options: OPTIONS,
    args: (split ? [...argv.slice(0, cmdPos + 1), ...split.rest] : argv).map((a) => a.startsWith('-') && a !== '--' && !isFlag(a) ? TEXT + a : a) });
} catch (e: any) {
  const name = /Unknown option '([^']+)'/.exec(e?.message)?.[1];
  const first = argv[cmdPos] ? ` ${argv[cmdPos]}` : '';
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

// Through this seat's relay when it has one (bridge.ts): its connection is already open. Not as cb-web: the
// relay's connection is named cb-relay, so a PGAPPNAME run connects itself.
// The relay is keyed per seat (machine + pane); one that has not restarted since Stage B is still keyed by its
// Claude's socket, so that key is tried once after the seat's.
const legacyKey = (socket: string) => createHash('sha1').update(socket).digest('hex').slice(0, 12);
const relayKeys = () => [seatKey(machine(), pane), ...(process.env.CLAUDE_CODE_MESSAGING_SOCKET ? [legacyKey(process.env.CLAUDE_CODE_MESSAGING_SOCKET)] : [])];
let sql: any = direct;
// doctor and update look at this machine (and the board's web address), never through a relay: they must work on a
// stale worker and while the database is down (cb update reads the board's schema once, directly, before installing)
// The manual (cb, cb help) too: it is compiled in, so it never asks who this pane is (#4755)
const manual = cmd === undefined || cmd === 'help';
const offline = manual || cmd === 'doctor' || cmd === 'update' || cmd === 'faults';
if (pane && !process.env.PGAPPNAME && !offline && !o.help)
  for (const k of relayKeys()) {
    const bridged = await openBridge(k, databaseUrl(), () => direct, { machine: machine(), pane }).catch(fault.bridgeError);
    if (bridged) { sql = bridged; break; }
  }
const boardHost = new URL(databaseUrl()).hostname;
const localBoard = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(boardHost);
// #4337: a remote board that is briefly unreachable is retried for ~10 s, one statement at a time and only when it never
// left this machine (connect-retry.ts). A local board that refuses is started instead (main()), with no wait first.
// Local is by name only: this machine's own Tailscale name or address counts as remote. cb start answers at once: it is
// advice that always exits 0.
if (!localBoard && cmd !== 'start') sql = withConnectRetry(sql);
useDb(sql);

let sessionProject: string | null = null;

/** This pane's binding (cb iam): its actor, unless --as/$CB_ACTOR say otherwise, and its project. */
async function resolveActor() {
  if (!pane) return;
  // the relay hands it over with the hello when it holds it (#3256): one round trip a command instead of two
  const [s] = sql.binding ? [sql.binding] : await sql`select actor, project from cb.sessions where machine = ${machine()} and pane = ${pane}`;
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

/** --repo a,b as a list; empty names (a trailing or doubled comma) dropped. */
const repoList = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

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

/** --image "Caption=path" or --image path, read before anything is posted so a bad file never leaves half a question.
 *  The type is checked again from the bytes in cb.question_image_add; this only gives the early, plain error. */
function images() {
  return (o.image ?? []).map((s: string) => {
    const i = s.indexOf('=');
    const [caption, path] = i > 0 && !existsSync(s) ? [s.slice(0, i).trim(), s.slice(i + 1).trim()] : [null, s.trim()];
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`--image ${path}: no such file. Give a PNG, JPEG, WebP or GIF, e.g. --image "Now=shots/now.png"`);
    if (statSync(path).size > 5 * 1024 * 1024) throw new Error(`--image ${path}: over 5 MB. Crop it to what matters, or save it as JPEG`);
    return { caption, data: readFileSync(path) };
  });
}
/** A question (or -c context) given as "-" comes from stdin: Markdown with a table or several paragraphs is easier
 *  as a heredoc than as one quoted argument. Only one of them can. */
async function fromStdin(text: string | null | undefined, what: string): Promise<string | null | undefined> {
  if (text !== '-') return text;
  if (o.context === '-' && what === 'question') throw new Error('stdin holds one text: give either the question or -c as "-", not both. Put the other in quotes');
  if (process.stdin.isTTY) throw new Error(`${what} "-" reads stdin: pipe it in, e.g. cb ${cmd} ... - <<'EOF' ... EOF`);
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  if (!s.trim()) throw new Error(`stdin was empty: the ${what} goes there when you give "-"`);
  return s.replace(/\s+$/, '');
}

async function addImages(tx: any, id: unknown, pics: ReturnType<typeof images>, replace: boolean) {
  for (const [n, p] of pics.entries())
    await tx`select cb.question_image_add(id => ${String(id)}, data => ${p.data}, caption => ${p.caption},
                                          replace_all => ${replace && n === 0}, actor => ${actor})`;
}

/** cb.mine rows, a part holder's (#3703) showing the part it holds: [part api: in_progress], as cb next does.
 *  repo desc: the Map keeps the last, so the first part by repo wins, as in mine, resume and stage_pass. */
async function partShown(rows: any[], who: string) {
  const held = new Map((await sql`select task_id, repo from cb._held_parts() where assignee = ${who} order by repo desc`).map((h: any) => [Number(h.task_id), h.repo]));
  return rows.map((t) => held.has(Number(t.id)) ? { ...t, status: `part ${held.get(Number(t.id))}: ${t.status}` } : t);
}

/** #4452: cb.mine keeps a card closed or moved off you for 24h, so a cancel or a reassignment is seen once. Those come
 *  after the open ones under their own heading, never as work. Split on the raw rows: partShown rewrites status. */
const MOVED_OFF = 'CLOSED OR MOVED OFF YOU IN THE LAST 24H (shown for a day so you see it: not yours to work on)';
const openFor = (who: string) => (t: any) => t.assignee === who && !['done', 'cancelled'].includes(t.status);
async function mineLines(rows: any[], who: string, indent: string) {
  const isOpen = rows.map(openFor(who)), words = await stageWordsFor(sql, rows); // #4512: one query for the list
  const shown = (await partShown(rows, who)).map((t, i) => indent + withStage({ ...t, stage_words: words[i] }));
  const gone = shown.filter((_, i) => !isOpen[i]);
  return { open: shown.filter((_, i) => isOpen[i]), gone: gone.length ? [MOVED_OFF, ...gone] : [], words };
}

// #4593 review 100 F3: a card's tags, a for:<agent> label in plain words ("for a Codex seat"), never the raw tag
const AGENT_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', agy: 'agy' };
function tagWords(labels: string[] | undefined): string {
  if (!labels?.length) return '';
  const agents = labels.map((l) => /^for:(.+)$/i.exec(l.trim())?.[1]?.toLowerCase()).filter((a): a is string => !!a && a in AGENT_NAMES).sort();
  const tags = labels.filter((l) => !/^for:/i.test(l.trim()));
  const seat = agents.length ? agents.map((a) => AGENT_NAMES[a]).join(' or ') : '';
  return (tags.length ? ` {${tags.join(', ')}}` : '') + (seat ? ` [for ${/^[aeiou]/i.test(seat) ? 'an' : 'a'} ${seat} seat]` : '');
}
const line = (t: any) =>
  `#${t.id} [${t.status ?? ''}] ${t.priority} ${t.type && t.type !== 'task' ? `${t.type}: ` : ''}${t.title}${tagWords(t.labels)}${t.assignee ? ` (${t.assignee})` : ''} · ${t.project}`.replace(' [] ', ' ');
// #4454: a staged card says its stage in words, so an unheld in-progress card at review reads as waiting for review, not
// as abandoned work. cb brief, cb show and cb mine (#4512) print it the same way.
const withStage = (t: any) => `${line(t)}${t.stage_words ? ` · ${t.stage_words}` : ''}`;

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

/** A note on one short line (#4454): every line break, control character (ESC, BEL, DEL, C1) and run of spaces is one
 *  space, cut at 100 characters. */
const clip = (s: unknown, n = 100) => {
  const c = [...String(s ?? '').replace(/[\s\p{Cc}]+/gu, ' ').trim()];
  return c.length > n ? `${c.slice(0, n - 1).join('').trimEnd()}…` : c.join('');
};

function printBrief(b: any) {
  const sec = (name: string, rows: any[], fmt: (r: any) => string) => {
    console.log(`${name} (${rows.length})`);
    for (const r of rows) console.log('  ' + fmt(r));
  };
  if (b.disabled) console.log(`PROJECT DISABLED: ${b.disabled}.`); // #4559: first, before its cards and questions
  sec('GOALS (their cards come right after P0)', b.goals ?? [], goalText);
  sec('IN PROGRESS', b.in_progress, withStage);
  // #4340: a staged card past build waits in Next for the lead (merge) or qa: say so, or it reads as build work
  sec('NEXT (take with `cb next`)', b.next, (t) => `${line(t)}${t.stage && t.stage !== 'build' ? ` · ${t.stage_words}` : ''}`);
  sec('BLOCKED', b.blocked, (t) => `${withStage(t)}${t.blocked_on ? ` — on Q${t.blocked_on}` : ''}${t.waits_on?.length ? ` — waits on #${t.waits_on.join(', #')}` : ''}` +
    (t.blocked_on || t.waits_on?.length ? '' : t.block_note ? ` — why: ${clip(t.block_note)}`
      : ` — no reason given${t.last_note ? `; last note: ${clip(t.last_note)}` : ''}`));
  sec('REVIEW', b.review, withStage);
  sec('WAITING ON AHMED', b.open_questions, (q) => `Q${q.id}${q.blocking ? ' [blocking]' : ''} ${q.body}${q.assigned_to ? ` (for ${q.assigned_to})` : ''} · ${q.project}`);
  sec('BROADCASTS (24h)', b.broadcasts ?? [], (x) => `${x.actor}${x.project ? ` to ${x.project}` : ' to everyone'}: ${x.summary}`);
  sec('ANSWERED — DELIVER THESE', b.answered_pending, (q) =>
    `Q${q.id} → ${q.asked_by}${q.reply_to?.pane ? ` (pane ${q.reply_to.pane}@${q.reply_to.machine})` : ''}: ${q.answer}${q.was != null ? ` (CHANGED, was: ${q.was})` : ''}`);
  sec('RULES & FACTS', b.memory?.entries ?? [], memLine);
}

/** cb pass, fail and stage: where the card went and who takes it (cb.next_step), as a line and as json. */
const stepOut = (s: any) => ({ out: !s.takes_it ? `#${s.id} → ${s.stage_words}. You: cb next`
  // a parts card (#3703): takes_it is its parts in words ("build: api done (PR #12), ...")
  : s.takes_it.startsWith(`${s.stage}: `) ? `#${s.id} → ${s.stage_words}; ${s.takes_it}. You: cb next`
  : `#${s.id} → ${s.stage_words}; ${s.takes_it} takes it. You: cb next`, json: s });

/** Projects are namespaces: a session bound to one project never changes another project's tasks. */

async function guard(id: string | undefined) {
  const n = Number(String(id ?? '').replace(/^#/, ''));
  if (!sessionProject || !Number.isInteger(n)) return;
  const [t] = await sql`select project from cb.tasks where id = ${n}`;
  if (t && t.project !== sessionProject)
    throw new Error(`#${n} is in ${t.project}; this session works in ${sessionProject}. Check the id: cb mine lists yours, cb brief your project's. Only ${t.project}'s own sessions change it.`);
}

/** Claude can hand its inbox to a relay here: in this env, or in a live endpoint file (never existsSync on a pipe). */
function claudeInbox(): boolean {
  if (process.env.CLAUDE_CODE_MESSAGING_SOCKET) return true;
  const ep = readClaudeEndpoint(machine(), pane);
  return !!ep && socketExists(ep.socket);
}

/** Is this seat's relay running? Same lock file as cli/relay.ts LOCK (or a pre-Stage B relay's). null = it cannot run here. */
function relayOn(): boolean | null {
  if (!pane) return null;
  for (const k of relayKeys())
    try {
      const pid = Number(readFileSync(join(tmpdir(), `cb-relay-${k}.pid`), 'utf8'));
      if (pid > 0) { process.kill(pid, 0); return true; }
    } catch {}
  if ((process.env.CB_AGENT || 'claude') === 'claude' && !claudeInbox()) return null;
  return false;
}

/** cb start: where this session stands and the one thing to run next. Read-only. --json (#4513): who, project, relay, and the text. */
async function start(): Promise<{ out: string; json: unknown }> {
  const [row] = pane ? await sql`select actor, project from cb.sessions where machine = ${machine()} and pane = ${pane}` : [];
  const relay = relayOn();
  const projects = async () => (await sql`select p.slug,
      count(t.id) filter (where t.status = 'next')::int as next, count(t.id) filter (where t.status = 'in_progress')::int as doing,
      (select count(*)::int from cb.sessions s where s.project = p.slug and s.last_seen > now() - interval '90 seconds') as live
    from cb.projects p left join cb.tasks t on t.project = p.slug where p.state = 'enabled' group by p.slug order by p.slug`) // #4559: only projects that get work
    .map((p: any) => `    ${p.slug.padEnd(16)} ${p.next} next, ${p.doing} in progress, ${p.live} sessions live`).join('\n') || '    (none yet: cb help project)';
  const via = o.as ? '--as' : process.env.CB_ACTOR ? '$CB_ACTOR' : row?.project ? 'bound to this pane' : 'not bound'; // the relay's own row (before cb iam) has no project
  const done = () => {
    const text = out.join('\n');
    return { out: text, json: { actor, via, project: sessionProject, relay: relay === null ? 'unavailable' : relay ? 'on' : 'off', text } };
  };
  const out = [`You       ${actor} (${via})`,
    `Project   ${sessionProject ?? (pane ? 'NOT BOUND' : 'none (no herdr pane)')}`,
    `Relay     ${relay === null ? `unavailable (${pane ? 'no Claude Code inbox here' : 'no herdr pane'}): run cb mine and cb pending between steps` : relay ? 'on' : 'OFF'}`, ''];

  if (!pane && !explicitActor) {
    out.push('NEXT', '  This session has no herdr pane ($HERDR_PANE_ID), so it cannot bind (cb iam) or relay.',
      '  Put --as <name> on every command, or export CB_ACTOR=<name> once, and name the project in each command:',
      '    cb next <project> --as W1@<machine>', '  Projects:', await projects(), '', 'Then: cb help start (the whole flow), cb help rules (read once).');
    return done();
  }
  if (pane && !sessionProject) {
    out.push('NEXT: bind this pane to a project (once; later commands act as that name, in that project)',
      `  cb iam <name> <project>        e.g. cb iam W1@${machine()} iris`,
      `  <name>: orch@${machine()} if you orchestrate the project; W<n>@${machine()} if you take tasks; R<n>@${machine()} if you review.`,
      '         Your prompt or your orchestrator names you; else pick the next free W<n> in cb sessions <project>.',
      '  <project>, one of:', await projects(),
      '  A new project? cb help project.', '', 'Then run cb start again. The whole flow: cb help start.');
    return done();
  }

  const mine: any = await callFn('mine', { actor });
  // cb.mine also lists tasks reassigned away in the last 24h: never tell the agent to continue those
  const open = mine.filter(openFor(actor)), held = await mineLines(mine, actor, '  ');
  const project = sessionProject;
  const queue = project ? await callFn('task_queue', { project, actor, lim: 3 }) as any[] : []; // what cb next would take: same filter and order
  const qs = await sql`select id, status, body, sent_back from cb.questions where asked_by = ${actor} and status in ('open', 'answered', 'sent_back') order by id`;
  const cut = (s: string) => (s.length > 100 ? s.slice(0, 99) + '…' : s);
  // Ahmed's asks (#936) waiting on this session's reply: a resumed session lost the terminal they were pushed into
  const asks = (await callFn('asks_list', { to_actor: actor, include_closed: false }) as any[]).filter((a) => a.awaiting);
  if (asks.length) out.push('AHMED ASKS YOU', ...asks.map((a) =>
    `  A${a.id}${a.late ? ` LATE ${dur((Date.now() - +new Date(a.delivered_at)) / 60000)}` : ''}${a.from_terminal ? ' (asked in your terminal)' : ''}: ${cut(flat(a.body))}`));
  out.push(`YOUR TASKS (cb mine)`, ...(held.open.length ? held.open : ['  none']), ...held.gone,
    `QUEUE HEAD${project ? ` (${project} Next; cb next takes the first)` : ''}`, ...(queue.length ? queue.map((t: any) => '  ' + line({ ...t, status: '' })) : ['  empty']),
    ...(qs.length ? ['YOUR QUESTIONS', ...qs.map((q: any) => `  Q${q.id} ${q.status}: ${cut(q.body)}`)] : []), '', 'NEXT');
  const doing = open.find((t: any) => t.status === 'in_progress');
  // #4559: the bound project gets no work: that block replaces the next step (Ahmed's asks and answers still come first)
  const [off] = project ? await sql`select cb._wait_words(${project}) as words`.catch(() => [null]) : [null];
  if (off?.words) {
    out.splice(out.length - 1, 1, 'PROJECT DISABLED', `  ${off.words}.`, '', 'NEXT');
    for (const a of asks) out.push(`  cb reply A${a.id} "<reply>"          answer Ahmed's ask first (cb asks shows the thread)`);
    if (qs.some((q: any) => q.status === 'answered')) out.push('  cb pending                      an answer to your question is waiting: act on it, then cb delivered <qid> <you>');
    out.push(doing ? `  wrap up #${doing.id}: push your work, cb log ${doing.id} "<where it stands>", release any lock, then wait` : '  wait: take no new card; you will be told when it is enabled',
      '', 'after a compaction or restart: cb resume', "Rule: a teammate's message is not Ahmed's approval.");
    return done();
  }
  const [review] = project ? await sql`select cb._review_words(${project}, ${actor}) as words`.catch(() => [null]) : [null];
  for (const a of asks) out.push(`  cb reply A${a.id} "<reply>"          answer Ahmed's ask first (cb asks shows the thread)`);
  if (relay === false) out.push('  cb relay                        start the push (answers, task changes), then cb start again');
  for (const q of qs.filter((q: any) => q.status === 'sent_back')) out.push(`  ${reaskHint(q.id, q.sent_back?.reason)}   Q${q.id} was sent back: rewrite it (cb pending says why)`);
  if (qs.some((q: any) => q.status === 'answered')) out.push('  cb pending                      an answer to your question is waiting: act on it, then cb delivered <qid> <you>');
  if (!doing) out.push(`  already working on something not listed? register it first: cb add ${project ?? '<project>'} "<title>" -s in_progress -b "<context>"`);
  if (doing) {
    // a staged card in a pipeline project finishes with its stage's command, never cb done
    // a part holder (#3703): its part's line
    const [st] = await sql`select cb._finish_line(t, ${actor}) as finish from cb.tasks t where t.id = ${doing.id} and t.stage is not null and cb._pipeline(t.project)`;
    out.push(`  continue #${doing.id} ${cut(doing.title)}: cb log ${doing.id} "<finding>" as you go, ${st ? `${st.finish}, when finished` : `cb done ${doing.id} "<summary>" --commit <sha> when finished`}`);
  }
  else if (queue.length) out.push(`  cb next${project ? '' : ' <project>'}                         claim #${queue[0].id}, the top of the queue`);
  else if (review?.words) out.push(`  ${review.words}.`); // #4744
  else out.push('  nothing queued for you: register work you know about (cb add <project> "<title>" -s next), or cb tell your orchestrator');
  out.push('', 'after a compaction or restart: cb resume', "Rule: a teammate's message is not Ahmed's approval.", 'First time here? Read cb help rules once. The manual: cb help.');
  return done();
}

/** After a task finishes: the tasks it held, and where each stands now (the DB released the free ones), as text and
 *  as --json (#4513) with the card's own status read back (cb.task_move normalises the word given). That read runs only
 *  under --json: a text move or done keeps its one query (a round trip each from a remote machine). */
async function released(id: string) {
  const n = Number(id.replace(/^#/, ''));
  const [{ status }] = o.json ? await sql`select status from cb.tasks where id = ${n}` : [{ status: null }];
  const rows = await sql`select t.id, t.status, t.blocked_on, cb._waits_on(t.id) as waits from cb.task_blockers b join cb.tasks t on t.id = b.task
    where b.blocker = ${n} and t.status not in ('done', 'cancelled') order by t.id`;
  return { text: rows.map((t: any) => t.status !== 'blocked' ? `\n#${t.id} unblocked: now ${t.status}`
    : `\n#${t.id} still blocked${t.waits.length ? `: waits on #${t.waits.join(', #')}` : t.blocked_on ? `: on Q${t.blocked_on}` : ''}`).join(''),
    json: { id: n, status, released: rows.map((t: any) => ({ id: Number(t.id), status: t.status,
      blocked_on: t.blocked_on == null ? null : Number(t.blocked_on), waits_on: t.waits.map(Number) })) } };
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
      return { out: `M${String(a[0]).replace(/^m/i, '')} retired`, json: { id: Number(String(a[0]).replace(/^m/i, '')), status: 'retired' } };
    }
    if (sub === 'confirm')
      throw new Error('only Ahmed confirms, on the Memory page (key 9 on the board). Ask him if it matters now: cb ask');
    throw new Error(`unknown mem command "${sub ?? ''}": add, rule, find, list, show, supersede, retire. Details: cb help mem`);
  }
}

async function run(): Promise<unknown> {
  if (!offline) await resolveActor();
  if ('answered' in sql) sql.answered = 0; // who this pane is was only read: the command's own steps count (ranWords)
  switch (cmd) {
    case 'start':
      return await start();
    case 'tag': {
      need(2, 'tag <id> <tag>... [-<tag>]...   e.g. cb tag 42 ocr tamarind -old');
      await guard(args[0]);
      const tags = args.slice(1);
      const now: any = await callFn('task_tag', { id: args[0], actor,
        add: tags.filter((x) => !x.startsWith('-')), remove: tags.filter((x) => x.startsWith('-')).map((x) => x.slice(1)) });
      return { out: `#${args[0].replace(/^#/, '')} tags: ${now.length ? now.join(', ') : '(none)'}`, json: now };
    }
    case 'user': {
      need(2, 'user add <name> ["Display Name"] [--admin]   e.g. cb user add cai "Cai"');
      if (args[0] === 'rotate' || args[0] === 'remove')
        throw new Error(`Ahmed does this on the Users page (key 7 on the board): a new link, or removing someone, is his call`);
      // Admin and password: the Users page's, or the VPS shell's (PGAPPNAME=cb-web) for the first admin, before anyone can sign in.
      if (args[0] === 'role') {
        need(3, 'user role <name> admin|member');
        await callFn('user_set_role', { name: args[1], role: args[2], actor });
        return { out: `${args[1].trim().toLowerCase()} is now ${args[2].trim().toLowerCase()}`, json: { name: args[1].trim().toLowerCase(), role: args[2].trim().toLowerCase() } };
      }
      if (args[0] === 'password') {
        // never an argument: it would sit in the shell history and the process list
        if (process.stdin.isTTY) throw new Error('pipe the password in: read -rs PW && printf %s "$PW" | cb user password <name>');
        let pw = '';
        for await (const chunk of process.stdin) pw += chunk;
        await callFn('user_password', { name: args[1], password: pw.replace(/\r?\n$/, ''), actor });
        return { out: `password set for ${args[1].trim().toLowerCase()}: they sign in on the board's login page`, json: { name: args[1].trim().toLowerCase(), password_set: true } };
      }
      if (args[0] !== 'add') throw new Error(`unknown user command "${args[0]}". Run: cb user add <name> ["Display Name"]; list people with cb users`);
      // The link is a member's login, so a session never gets it (cb.user_add returns it to the dashboard only).
      await callFn('user_add', { name: args[1], display: args[2] ?? null, actor, ...(o.admin ? { role: 'admin' } : {}) });
      const [u] = await sql`select name, display, role from cb.users where name = ${args[1].trim().toLowerCase()}`;
      return { out: u.role === 'admin' ? `added ${u.name} (${u.display}) as admin: set a password (cb user password ${u.name}) and they sign in on the login page`
        : `added ${u.name} (${u.display}): Ahmed copies their link from the Users page`, json: u };
    }
    case 'users': {
      const rows = await sql`select u.name, u.display, u.role,
        (select count(*)::int from cb.questions q where q.assigned_to = u.name and q.status = 'open') as open_questions,
        (select count(*)::int from cb.tasks t where t.assignee = u.name and t.status not in ('done','cancelled')) as open_tasks
        from cb.users u order by u.name`;
      return { out: rows.map((r: any) => `${r.name.padEnd(12)} ${r.display}${r.role === 'admin' ? ' (admin)' : ''}: ${r.open_questions} questions, ${r.open_tasks} tasks open`).join('\n') || 'no users (cb user add cai "Cai")', json: rows };
    }
    case 'github': {
      // The GitHub watch (#1207): one cb.settings row per repo; the board server polls them (server/github.ts). The rules
      // (Ahmed only, the defaults, the checkpoint) are SQL, shared with the project settings page (#4523, #4332).
      const sub = args[0];
      if (sub === 'add' || sub === 'remove') {
        need(2, 'github add <owner/repo> [--project <project>] [--to <session>] [--cards-in <project,...>]   or   cb github remove <owner/repo>');
        const repo = args[1];
        if (sub === 'remove') {
          await callFn('github_watch_remove', { repo, actor });
          return { out: `stopped watching ${repo}; its cards stay on the board`, json: { repo, watched: false } };
        }
        // --cards-in (#4334): more projects whose cards a PR may name (fix/<card>-..., "(card <n>)"); "" clears them
        const cardsIn = o['cards-in'] === undefined ? null : String(o['cards-in']).split(',').map((x) => x.trim()).filter(Boolean);
        // the pane's project is the default only for a repo not watched yet (SQL decides): a bare re-add changes nothing
        const v: any = await callFn('github_watch_add', { repo, project: o.project ?? null, tell: o.to ?? null, cards_in: cardsIn,
          default_project: sessionProject, actor });
        return { out: `watching ${repo}: ${v.to} is told, PR cards go in ${v.project}${v.card_projects?.length
          ? ` (a PR naming a card in ${[v.project, ...v.card_projects].join(', ')} logs on that card)` : ''}, events from ${v.since} on`, json: v };
      }
      if (sub === 'mute' || sub === 'unmute') {
        // a login whose PRs, comments, reviews and commits the watch drops (Ahmed's own workers post as one): his call
        need(2, 'github mute <login>   or   cb github unmute <login>');
        const login = args[1].toLowerCase();
        const next = await callFn('github_mute', { login: args[1], mute: sub === 'mute', actor });
        return { out: sub === 'mute' ? `muted ${login}: its PRs, comments, reviews and commits no longer reach the watch (failed CI runs still do)`
          : `unmuted ${login}`, json: next };
      }
      if (sub) throw new Error(`unknown github command "${sub}": cb github lists, cb github add <owner/repo>, cb github remove <owner/repo>, cb github mute <login>`);
      const { watches, muted }: any = await callFn('github_watches', {});
      const out = watches.map((v: any) => {
        const cards = Object.entries(v.prs ?? {});
        return [`${v.repo} → ${v.to} (${v.project}${v.card_projects?.length ? `; named cards also in ${v.card_projects.join(', ')}` : ''}) · last poll ${v.last_ok ? `${dur((Date.now() - Date.parse(v.last_ok)) / 60000)} ago` : 'never'} · since ${v.since}` +
          (v.last_error ? ` · last error: ${flat(v.last_error.message)} (since ${v.last_error.at})` : ''),
          ...(cards.length ? [`  open PR cards: ${cards.map(([n, id]) => `PR #${n} → card #${id}`).join(', ')}`] : [])].join('\n');
      });
      if (muted?.length) out.push(`muted (their events are dropped): ${muted.join(', ')}`);
      return { out: out.join('\n') || 'no repos watched (Ahmed adds them: cb github add <owner/repo>)', json: watches };
    }
    case 'assign': {
      need(2, 'assign <Q12|#34> <user|ahmed>   hand a question or task to a user (ahmed takes a question back)');
      const target = args[0], to = args[1] === 'ahmed' ? null : args[1];
      if (/^q\d+$/i.test(target)) {
        await callFn('question_assign', { id: target.slice(1), to_user: to, actor });
        return { out: `Q${target.slice(1)} → ${to ?? 'ahmed'}`, json: { id: Number(target.slice(1)), kind: 'question', assigned_to: to } };
      }
      await guard(target);
      if (to && !(await sql`select 1 from cb.users where name = ${to}`).length) throw new Error(`unknown user ${to}: see cb users, or add them with cb user add ${to} "<Display Name>"`);
      await callFn('task_update', { id: target, fields: { assignee: to }, actor });
      return { out: `#${target.replace(/^#/, '')} → ${to ?? 'nobody'}`, json: { id: Number(target.replace(/^#/, '')), kind: 'task', assignee: to } };
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
        need(2, 'huddle open "<topic>" <session>... [-t task]   e.g. cb huddle open "Date parsing" W3@macbook -t 59');
        if (o.task) await guard(o.task);
        const id = await callFn('huddle_open', { topic: args[1], members: args.slice(2), task: o.task ?? null, actor });
        return { out: `huddle #${id} open with ${args.slice(2).join(', ') || 'nobody yet'}; talk with: cb huddle say ${id} "..."`,
          json: { id: Number(id), members: args.slice(2), task: o.task == null ? null : Number(String(o.task).replace('#', '')) } };
      }
      need(2, 'huddle say|add|close|show <id> ...');
      const id = args[1].replace(/^#/, '');
      if (sub === 'say') {
        need(3, 'huddle say <id> "<message>"');
        const ev = await callFn('huddle_say', { id, message: args.slice(2).join(' '), actor });
        return { out: `said in huddle #${id}`, json: { id: Number(ev), huddle: Number(id) } };
      }
      if (sub === 'add') {
        need(3, 'huddle add <id> <session>...');
        const added: any = await callFn('huddle_add', { id, members: args.slice(2), actor });
        return { out: `huddle #${id}: added ${added.join(', ') || 'nobody new'}`, json: added };
      }
      if (sub === 'close') {
        await callFn('huddle_close', { id, summary: args.slice(2).join(' ') || null, actor });
        return { out: `huddle #${id} closed`, json: { id: Number(id), status: 'closed' } };
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
      // relay not live: a session still writing to the board only lost its relay (#4341); say which, and that it waits.
      // A name with no session row (a pane re-bound to another name, or a session that never started a relay) is not
      // "relay down", as in the digest; but if it wrote lately, say so rather than "it may be gone" (#4421)
      const [s] = await sql`select coalesce((select max(last_seen) > now() - interval '90 seconds' from cb.sessions where actor = ${args[0]}), false) as live,
        exists (select 1 from cb.sessions where actor = ${args[0]}) as has_row, cb._board_active(${args[0]}) as mins`;
      // one word for --json (#4453), the text below says the same in words
      const delivery = s.live ? 'live' : s.mins === null ? 'not_seen' : s.has_row ? 'relay_down' : 'no_session';
      const how = { live: 'relay live: delivered within seconds',
        no_session: `no relay session on the board under this name, but it last wrote to the board ${s.mins}m ago: the message waits up to 24h for a relay under this name`,
        relay_down: `its relay is down, but the session last wrote to the board ${s.mins}m ago: the message waits until its relay restarts, up to 24h; reach it in its pane to run cb relay --restart`,
        not_seen: 'relay not live and nothing from the session on the board in 30 minutes: it may be gone; the message waits up to 24h for its relay to start' }[delivery];
      return { out: `message #${id} to ${args[0]} (${how})`,
        json: { id, to: args[0], delivery, last_wrote_mins: s.mins, waits_hours: delivery === 'live' ? null : 24 } };
    }
    case 'sessions': {
      const rows: any = await callFn('sessions_overview', { project: args[0] ?? sessionProject ?? null });
      const idle = (r: any) => (r.last ? (Date.now() - +new Date(r.last.at)) / 60000 : Infinity);
      const open = rows.filter((r: any) => r.live || r.doing.length || r.queued || r.open_questions);
      const out = open.map((r: any) => {
        const head = `${r.actor}${r.role ? ` (${r.role})` : ''} ${r.live ? 'relay live' : 'no relay'}${r.pane ? ` · ${r.pane}` : ''} · idle ${dur(idle(r))}` +
          ` · ${r.queued} queued · ${r.done_24h} done 24h${r.open_questions ? ` · ${r.open_questions} asking Ahmed` : ''}` +
          (!r.live && r.doing.length && idle(r) > 60 ? '  ⚠ holds work, gone quiet' : '');
        const drift = modelDrift(r); // #4786
        return [head, ...(drift ? [drift] : []), ...(r.doing.length ? r.doing.map((t: any) => `  #${t.id} ${t.title} [${t.part ? `part ${t.part}: ` : ''}${t.status}]`) : ['  (nothing in progress)'])].join('\n');
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
      need(1, 'broadcast "<message>" --project <p> | --all');
      const id = await callFn('broadcast', { message: args.join(' '), project: o.project ?? null, actor, everyone: !!o.all });
      return { out: `broadcast #${id} sent to ${o.project ? `every ${o.project} session` : 'every session'}`, json: { id: Number(id), project: o.project ?? null } };
    }
    case 'relay': {
      if (!pane) throw new Error('cb relay needs a herdr pane ($HERDR_PANE_ID). Without a relay, run cb mine and cb pending between steps');
      // --agent, then $CB_AGENT, then the agent this pane is bound with, else claude
      const agent: string = o.agent || process.env.CB_AGENT ||
        (await sql`select agent from cb.sessions where machine = ${machine()} and pane = ${pane}`.catch(() => []))[0]?.agent || 'claude';
      getAdapter(agent); // an agent cb cannot serve yet fails here, by name
      if (agent === 'claude' && !claudeInbox()) throw new Error('no session inbox here (needs a Claude Code session, 2.1.234+). Without a relay, run cb mine and cb pending between steps');
      // through the path cb was started with, not its real one: a release flip then restarts the relay (started-as.ts)
      const r = spawnSync(process.execPath, [join(dirname(startedAs(process.argv[1], import.meta.filename)), 'relay.ts'), '--pane', pane, '--agent', agent, ...(o.restart ? ['--restart'] : [])], { stdio: 'ignore' });
      // #4429: a relay that refused this seat exits 1 (and told the project on the board when it could); never "relay on"
      if (r.status !== 0) throw new Error(`the relay did not start (exit ${r.status ?? r.signal}); its reason is in the relay log, cb-relay-*.log in this machine's temp folder. Without a relay, run cb mine and cb pending between steps`);
      return { out: `relay on for ${pane}@${machine()}: answers and changes to your tasks now arrive in this session`, json: { machine: machine(), pane, agent, relay: 'on' } };
    }
    case 'iam': {
      need(1, 'iam <name> [project] [--role <role>] [--area <area>] [--model <model>] [--repo <repo>] [--agent <agent>]   e.g. cb iam W1@macbook iris --role builder');
      if (!pane) throw new Error('cb iam needs a herdr pane ($HERDR_PANE_ID); use --as <name> on each command instead');
      // a Claude cb iam sends no agent: the 8 arguments a rolled-back cb.iam still takes (cli/iam-args.ts)
      const p = await callFn('iam', iamArgs({ machine: machine(), pane, actor: args[0]!, project: args[1], role: o.role, area: o.area,
        model: o.model, repo: o.repo, agent: o.agent }, process.env.CB_AGENT));
      const [b] = await sql`select project, role, area from cb.sessions where machine = ${machine()} and pane = ${pane}`;
      const pack = b?.project ? packText(await callFn('mem_pack', { project: b.project, machine: machine() })) : '';
      const goals = b?.project ? goalsText(await callFn('goals_list', { project: b.project }) as any[]) : '';
      return { json: { actor: p, machine: machine(), pane, project: b?.project ?? null, role: b?.role ?? null, area: b?.area ?? null },
        out: `this pane (${pane}@${machine()}) is ${p}${b?.role ? ` as ${b.role}${b.area ? ` (area ${b.area})` : ''}` : ''}${b?.project ? `, working on ${b.project}` : ' (no project: add one, cb iam <name> <project>)'}${pack ? `\n\n${pack}` : ''}${goals ? `\n\n${goals}` : ''}${b?.role ? `\n\nYour role: cb role ${b.role}` : ''}` };
    }
    case 'mem':
      return await mem();
    case 'add': {
      need(2, 'add <project> "<title>" ["<body>"] [-s next] [-p P1]   e.g. cb add iris "Fix month parse" "row 8812 reads 1900" -s next');
      if (o.why && !o.stage) throw new Error('--why goes with --stage build: cb add <project> "<title>" --stage build --why "<why>"');
      const tb = titleBody('add', args.slice(1), o.body);
      const id = await callFn('task_add', { project: args[0], title: tb.title, body: tb.body ?? '',
        status: o.status ?? null, priority: o.priority ?? 'P2', labels: o.labels ? o.labels.split(',') : [],
        links: links(), assignee: o.assignee ?? null, actor, ...(o.type ? { type: o.type } : {}), ...(o.epic ? { epic: o.epic } : {}),
        ...(o.stage ? { stage: o.stage, why: o.why ?? null } : {}), ...(o.repo ? { repos: repoList(o.repo) } : {}) });
      // --json (#4513): what was stored (a project alias resolved, the default status). #4559: and whether its project gets
      // work (a disabled one parks the card in its Backlog), so the filer is told
      const [t] = await sql`select project, status, stage, cb._state_words(project) as words from cb.tasks where id = ${Number(id)}`;
      const parked = t.words ? `#${id} filed in ${t.project}'s Backlog: ${t.words}; nobody picks it up until Ahmed enables it` : null;
      if (!o.json) return { out: parked ?? `#${id}` };
      return { json: { id: Number(id), project: t.project, status: t.status, stage: t.stage, ...(parked ? { disabled: t.words } : {}) } };
    }
    case 'bug': {
      need(2, 'bug <project> "<title>" -b "what happened, how to reproduce, expected vs actual" [--stage build --why "<why>"] [--repo <repo,repo>]');
      const tb = titleBody('bug', args.slice(1), o.body);
      if (!tb.body?.trim()) throw new Error('describe it: -b "what happened, how to reproduce, expected vs actual"');
      if (o.why && !o.stage) throw new Error('--why goes with --stage build: cb bug <project> "<title>" -b "<what happened>" --stage build --why "<why>"');
      await sql`select cb.read_project(${args[0]})`; // a typo errors with the known projects instead of creating one
      const id = await callFn('task_add', { project: args[0], title: tb.title, body: tb.body, status: 'next',
        priority: o.priority ?? 'P2', labels: o.labels ? o.labels.split(',') : [], links: links(), actor, type: 'bug',
        ...(o.stage ? { stage: o.stage, why: o.why ?? null } : {}), ...(o.repo ? { repos: repoList(o.repo) } : {}) });
      // orch: one of those told is the project's lead (the lead role, whatever its name; #3746)
      const [{ project, all, stage, multi, orch, words }] = await sql`select t.project, cb.triagers(t.project) as all, t.stage,
        t.repos is null and cb._multi_repo(t.project) as multi,
        exists (select 1 from unnest(cb.triagers(t.project)) x where x <> ${actor} and cb._is_lead(x, t.project)) as orch,
        cb._state_words(t.project) as words
        from cb.tasks t where t.id = ${id}`;
      // #4559 (Q3020): a disabled project takes the report but parks it, and nobody triages it there (cb.inbox)
      if (words) return { out: `#${id} bug filed in ${project}'s Backlog: ${words}; nobody picks it up until Ahmed enables it`, json: { id, project, told: [], stage, disabled: words } };
      const told = all.filter((a: string) => a !== actor);
      if (stage) return { out: stage === 'design' ? `#${id} starts at design; a small fix can skip it: the lead runs cb stage ${id} build${multi ? ' --repo <repo,repo>' : ''} --why "..."` : `#${id} is in build`, json: { id, project, told, stage } };
      const who = told.length ? `told ${told.join(', ')}${orch ? '' : ' (no orchestrator there)'}`
        : all.length ? `you triage it: cb edit ${id} --assignee <worker>` : `no session works in ${project} yet: it waits in Next`;
      return { out: `#${id} bug filed in ${project}; ${who}`, json: { id, project, told } };
    }
    case 'stage': {
      need(2, 'stage <id> build|none --why "<why>" [--repo <repo,repo>]   (the lead: a small bug or chore skips design; none = no code, worked the old way)');
      await guard(args[0]);
      await callFn('stage_set', { id: args[0], stage: args[1], why: o.why ?? null, actor, ...(o.repo ? { repos: repoList(o.repo) } : {}) });
      return stepOut(await callFn('next_step', { id: args[0] }));
    }
    case 'pass': {
      need(2, 'pass <id> "<summary>" [--pr <url>] [--commit <sha>] [--repo <repo>]   e.g. cb pass 42 "built, tests green" --pr https://github.com/o/r/pull/9 (or https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/9)');
      await guard(args[0]);
      await callFn('stage_pass', { id: args[0], summary: args.slice(1).join(' '), links: links(), actor, ...(o.repo ? { repo: o.repo.trim() } : {}) });
      return stepOut(await callFn('next_step', { id: args[0] }));
    }
    case 'fail': {
      need(2, 'fail <id> "<why>" [--to design] [--repo <repo>]   e.g. cb fail 42 "the error path is missing"');
      await guard(args[0]);
      await callFn('stage_fail', { id: args[0], why: args.slice(1).join(' '), to_stage: o.to ?? null, actor, ...(o.repo ? { repo: o.repo.trim() } : {}) });
      return stepOut(await callFn('next_step', { id: args[0] }));
    }
    case 'move':
      need(2, 'move <id> <status> ["<note>"]');
      await guard(args[0]);
      await callFn('task_move', { id: args[0], status: args[1], note: args.slice(2).join(' ') || null, actor });
      return released(args[0]).then((r) => ({ out: `#${args[0].replace('#', '')} → ${args[1]}${r.text}`, json: r.json }));
    case 'done':
      need(2, 'done <id> "<summary>" [--commit <sha>] [--pr <url>]   e.g. cb done 42 "Date parse fixed" --commit ab12cd3');
      await guard(args[0]);
      await callFn('task_done', { id: args[0], summary: args.slice(1).join(' '), links: links(), actor });
      return released(args[0]).then((r) => ({ out: `#${args[0].replace('#', '')} done${r.text}`, json: r.json }));
    case 'block':
    case 'unblock': {
      need(1, `${cmd} <task> --by <task>   e.g. cb ${cmd} 13 --by 12`);
      if (!o.by) throw new Error(`usage: cb ${cmd} <task> --by <task>   e.g. cb ${cmd} 13 --by 12. Details: cb help ${cmd}`);
      await guard(args[0]);
      await callFn(cmd === 'block' ? 'task_block' : 'task_unblock', { task: args[0], blocker: o.by, actor });
      const [t] = await sql`select id, status from cb.tasks where id = ${Number(args[0].replace(/^#/, ''))}`;
      const by = o.by.replace(/^#/, '');
      return { out: `#${t.id} ${cmd === 'block' ? 'waits on' : 'no longer waits on'} #${by} (now ${t.status})`,
        json: { id: Number(t.id), by: Number(by), waits: cmd === 'block', status: t.status } };
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
      if (o.repo !== undefined) fields.repos = repoList(o.repo);
      const l = links(); if (Object.keys(l).length) fields.links = l;
      await callFn('task_update', { id: args[0], fields, actor });
      return { out: `#${args[0].replace('#', '')} updated`, json: { id: Number(args[0].replace('#', '')), changed: Object.keys(fields) } };
    }
    case 'page': {
      const sub = args[0];
      if ((sub !== 'show' && sub !== 'set') || (o.area ? args.length !== 1 : args.length !== 2))
        throw new Error('usage: cb page show <task> [--approved]  |  cb page set <task> -f <file|->  (an area page: --area <name> [--project p] instead of <task>)');
      const target = o.area ? { area: o.area, project: o.project ?? sessionProject ?? null } : { task: args[1].replace('#', '') };
      if (o.area && !target.project) throw new Error('an area page needs a project: --project <name>');
      if (sub === 'set') {
        if (!o.file) throw new Error('give the page text: -f <file>, or -f - for stdin');
        const body = o.file === '-' ? await fromStdin('-', 'page') : readFileSync(o.file, 'utf8');
        if (!o.area) await guard(args[1]);
        const v = await callFn('page_set', { body, ...target, actor });
        return { out: `page saved, v${v}`, json: { task: o.area ? null : Number(args[1].replace('#', '')), area: o.area ?? null,
          project: o.area ? target.project : null, version: Number(v) } };
      }
      const pg = await callFn('page_get', target);
      if (!pg) throw new Error(`no page yet for ${o.area ? `area ${o.area}` : `#${args[1].replace('#', '')}`}: write it with cb page set`);
      if (o.approved && pg.approved_version == null) throw new Error('nothing approved on this page yet');
      const body = o.approved ? pg.approved_body : pg.body, ver = o.approved ? pg.approved_version : pg.version;
      const who = o.approved ? pg.approved_by : pg.updated_by;
      const t = new Date(o.approved ? pg.approved_at : pg.updated_at).toISOString().slice(0, 16).replace('T', ' ');
      const head = `${o.area ? `${o.area} page for ${pg.project}` : `design page for #${pg.task_id}`}, v${ver}${!o.approved && pg.approved_version ? ` (approved v${pg.approved_version})` : ''} · ${who} · ${t}`;
      return { out: `${head}

${body}`, json: pg };
    }
    case 'log':
      need(2, 'log <task id> "<what happened>"   e.g. cb log 130 "B64 graded 27/32"');
      // `cb log 130 "..."` means task #130 (sessions kept typing it), not a project named "130"
      if (/^#?\d+$/.test(args[0]) && !o.task) {
        const [t] = await sql`select project from cb.tasks where id = ${Number(args[0].replace('#', ''))}`;
        if (!t) throw new Error(`no task #${args[0].replace('#', '')}: check the id (cb mine, cb brief). A project note is cb log <project> "..."`);
        o.task = args[0].replace('#', '');
        args[0] = t.project;
      }
      await guard(o.task);
      return callFn('log', { project: args[0], summary: args.slice(1).join(' '), task_id: o.task ?? null, actor })
        .then((ev) => ({ out: 'logged', json: { id: Number(ev), task: o.task == null ? null : Number(String(o.task).replace('#', '')) } }));
    case 'next': {
      const project = args[0] ?? sessionProject;
      if (!project) throw new Error('no project: say which (cb next iris) or bind this session once (cb iam <name> <project>)');
      if (sessionProject) {
        const [{ p }] = await sql`select cb.resolve(${project}) as p`;
        if (p !== sessionProject) throw new Error(`this session works in ${sessionProject}; ${p}'s work is for ${p}'s sessions. Run: cb next (takes from ${sessionProject})`);
      }
      const rows: any = await callFn('task_claim', { project, actor });
      if (!rows.length) {
        // #4559: a disabled project hands out nothing: say so, and what to do meanwhile. Read only when nothing came, and a
        // board without the words (a rolled-back schema) still answers
        const [w] = await sql`select cb._wait_words(cb.resolve(${project})) as words`.catch(() => [null]);
        if (w?.words) return { out: w.words, json: null };
        // #4744: a reviewer in a project without stages: the lead hands out its reviews, so say that, not "nothing"
        const [v] = await sql`select cb._review_words(cb.resolve(${project}), ${actor}) as words`.catch(() => [null]);
        if (v?.words) return { out: v.words, json: null };
        // #4593: name the cards kept for another agent, so a seat sees why the queue looks empty to it
        const [k] = await sql`select cb._for_skipped(cb.resolve(${project}), ${actor}) as s`.catch(() => [null]);
        return { out: k?.s ? `nothing to claim (skipped ${k.s})` : 'nothing to claim', json: k?.s ? { claimed: null, skipped: k.s } : null }; // review 100 F3: --json says it too
      }
      const t = rows[0];
      const staged = t.stage ? (await callFn('resume', { actor }) as any).cards.find((c: any) => c.id === t.id) : null; // stage null here = pipeline off: cb done
      // a part claim (#3703) leaves the card in Next: show the part taken and its status instead
      const shown = staged?.part ? { ...t, status: `part ${staged.part.repo}: ${staged.status}` } : t;
      return { out: `${line(shown)}${t.body ? '\n\n' + t.body : ''}${staged ? '\n\n' + cardBlock(staged, false) : ''}`, json: staged ? { ...t, ...staged } : t };
    }
    case 'resume': {
      const r: any = await callFn('resume', { actor });
      return { out: resumeText(r), json: r };
    }
    case 'squad': {
      if (!['show', 'set', 'up', 'trust', 'primary'].includes(args[0] ?? '') || args.length !== (args[0] === 'primary' ? 3 : 2)) throw new Error('usage: cb squad show <project> [--json]  |  cb squad set <project> -f <file|-> [--overwrite]  |  cb squad up <project> [--dry-run]  |  cb squad trust <project> [--machine <m>] [--dry-run]  |  cb squad primary <project> <seat>');
      if (args[0] === 'primary') { // #4787: ends a seat's backup; there is no automatic way back
        const ended = (await sql`select cb.seat_backup_clear(${args[1]}, ${args[2]}, ${actor}) as r`)[0].r;
        return { out: ended ? `${args[2]} is back on its squad setting: it changes at its next start, or the supervisor restarts it once idle` : `${args[2]} is on no backup`, json: { project: args[1], seat: args[2], ended } };
      }
      // #4575: Ahmed's one step per machine; it writes only this machine's agent config files, never the board
      if (args[0] === 'trust') { const out = await squadTrust(args[1], { machine: o.machine, dryRun: !!o['dry-run'], callFn }); return { out, json: { project: args[1], lines: out.split('\n') } }; }
      if (args[0] === 'up') { const out = await squadUp(args[1], !!o['dry-run'], callFn); return { out, json: { project: args[1], dry_run: !!o['dry-run'], lines: out.split('\n') } }; }
      if (args[0] === 'set') {
        if (!o.file) throw new Error('give the squad file: -f <file>, or -f - for stdin');
        const text = o.file === '-' ? await fromStdin('-', 'squad') : readFileSync(o.file, 'utf8');
        let squad: any;
        try { squad = JSON.parse(text as string); } catch { throw new Error('the squad file is not valid JSON'); }
        // #4332: "version" (from cb squad show --json) is the copy's base, not part of the squad: a squad saved since that
        // version is refused (cb.squad_set), so an old file can't silently undo a newer change made on the page
        const doc = squad && typeof squad === 'object' && !Array.isArray(squad) ? { ...squad } : squad;
        const hasVersion = doc && typeof doc === 'object' && !Array.isArray(doc) && 'version' in doc;
        const base = hasVersion ? doc.version : null;
        if (hasVersion) delete doc.version;
        if (hasVersion && !(Number.isInteger(base) && base >= 0))
          throw new Error(`"version" in the squad file must be the number cb squad show ${args[1]} --json printed`);
        // a file with no version: the version just read is its base, so it may not undo a newer change unless --overwrite
        // says replace what is there. Even then a save made between this read and the set is refused (the race check).
        const now = ((await callFn('squad_get', { project: args[1], with_version: true })) as any)?.version ?? 0;
        if (!hasVersion && now > 0 && !o.overwrite)
          throw new Error(`${args[1]}'s squad was saved as version ${now}, and this file has no version, so it could undo a newer change. Take the current squad with cb squad show ${args[1]} --json, edit that and set it again. (--overwrite replaces the current squad with this file, including any change made on the settings page.)`);
        const saved: any = await callFn('squad_set', { project: args[1], squad: doc, actor, base: o.overwrite || !hasVersion ? now : base, with_version: true });
        return { out: saved.changed ? `squad saved for ${args[1]} (version ${saved.version})`
          : `nothing changed for ${args[1]}: the squad is already this (version ${saved.version})`, json: saved };
      }
      const sq = await callFn('squad_get', { project: args[1], with_version: true }) as any;
      if (!sq) throw new Error(`${args[1]} has no squad yet: write one with cb squad set ${args[1]} -f <file>`);
      const { version: _v, ...plain } = sq;
      return { out: squadShow(plain), json: sq };
    }
    case 'models': { // #4763: this machine's agent CLI model lists, sent for the settings page
      if (args.length > 1 || (args[0] !== undefined && args[0] !== 'report')) throw new Error('usage: cb models  |  cb models report [--machine <name>]');
      if (args[0] === 'report') {
        const name = String(o.machine ?? machine()).toLowerCase();
        const lines = await reportModels({ machine: name, list: makeLister(),
          save: async (m, lists) => (await sql`select cb.machine_models_set(${m}, ${JSON.stringify(lists)}::text::jsonb, ${actor}) as r`)[0].r });
        return { out: lines.join('\n'), json: { machine: name, lines } };
      }
      if (o.machine !== undefined) throw new Error('--machine goes with report: cb models report --machine <name>');
      const all = ((await callFn('squad_options', {})) as any).machine_models ?? {};
      return { out: modelsShow(all), json: all };
    }
    case 'run':
      return runCmd(sql, { recipe: args[0], sha: o.sha, card: o.card, project: o.project ?? sessionProject, repo: o.repo?.trim() || undefined, params: runParams, wait: !!o.wait, json: !!o.json, actor });
    case 'jobs': {
      const named = args[0] ?? o.project;
      // a card's jobs are found whatever project this session is bound to
      if (o.ended) return endedCmd(sql, { project: named ?? (o.card !== undefined ? null : sessionProject), requester: o.mine ? actor : undefined, card: o.card });
      if (o.mine || o.card !== undefined) throw new Error('--mine and --card go with --ended: cb jobs --ended [--mine] [--card <id>]');
      return jobsCmd(sql, named ?? sessionProject);
    }
    case 'usage': return usageCmd(sql, o.all ? null : args[0] ?? sessionProject ?? null, o.since); // #4349
    case 'faults': return faultsCmd({ since: o.since }); // #4535: this machine's fault log; never the board
    case 'triage': // #4535: judge the fault log's groups and file the real ones on claude-board
      return triageCmd(sql, { since: o.since, agent: o.agent, model: o.model, max: o.max, budget: o.budget, dryRun: !!o['dry-run'], force: !!o.force, actor });
    case 'job': { // cb job <id> is cb job show <id>
      const bare = /^#?\d+$/.test(args[0] ?? '');
      return jobCmd(sql, bare ? 'show' : args[0], bare ? args[0] : args[1], actor, o.tail, args[2]);
    }
    case 'runner': { // the daemon (node cli/runner.ts), run in a herdr pane on the PC
      const r = spawnSync(process.execPath, [...process.execArgv, join(import.meta.dirname, 'runner.ts')], { stdio: 'inherit' });
      return { code: r.status ?? 1 };
    }
    case 'supervise': { // the supervisor daemon (node cli/supervise.ts), run in herdr tab `supervisor` on the PC
      const flags = [...(o['dry-run'] ? ['--dry-run'] : []), ...(o.once ? ['--once'] : [])];
      const r = spawnSync(process.execPath, [...process.execArgv, join(import.meta.dirname, 'supervise.ts'), ...flags], { stdio: 'inherit' });
      return { code: r.status ?? 1 };
    }
    case 'doctor':
      return doctorCmd({ root: o.root, manifest: o.manifest });
    case 'update': {
      // the copy's path as cb was started (a link after the first install), not the real folder of the version in use
      const root = o.root ?? resolve(dirname(startedAs(process.argv[1], import.meta.filename)), '..');
      if (o.rollback) { const r = rollback({ root, force: !!o.force }); return { out: r.lines.join('\n'), json: r.json }; }
      const from = o.from || process.env.CB_PUBLIC_URL || dotenv('PUBLIC_URL') || '';
      if (o.check) { const r = await updateCheck({ root, from: needAddress(from) }); return { out: r.lines.join('\n'), json: r.json, code: r.ok ? 0 : 1 }; }
      // checks the copy before it needs the address; the schema gate is its one read of the board's database
      const r = await install({ root, from, force: !!o.force, schema: (need) => askSchema(sql, need) });
      return { out: r.lines.join('\n'), json: r.json };
    }
    case 'role': {
      need(1, 'role <role> [--project p] [--json]   e.g. cb role builder');
      // #4525: in a project (this session's, or --project), its addition and who its seats ask first follow the shared text
      const project = o.project ?? sessionProject ?? null;
      // actor: the session named as the one to ask first is told seats ask it. A board whose schema predates #4525 has
      // only role_text(role): fall back to it, so the role is never lost
      const text = await callFn('role_text', { role: args[0], project, actor }).catch((e: any) => {
        if (!/function cb\.role_text\(.*\) does not exist/.test(e?.message ?? '')) throw e;
        return callFn('role_text', { role: args[0] });
      }) as string;
      return { out: text, json: { role: args[0], project, text } };
    }
    case 'show': {
      need(1, 'show <task id>   e.g. cb show 42');
      if (!/^#?\d{1,15}$/.test(args[0])) throw new Error(`"${args[0]}" is not a task id: give the number, e.g. cb show 42`);
      const n = Number(args[0].replace('#', ''));
      // #4512: the stage in words, as cb brief prints it (cb._brief_tasks: pipeline on and a stage set), in the same read
      const [t] = await sql`select t.*, case when cb._pipeline(t.project) and t.stage is not null then cb._stage_words(t.stage) end as stage_words
        from cb.tasks t where t.id = ${n}`;
      if (!t) throw new Error(`no task #${n}: check the id (cb mine, cb brief)`);
      // #4448: the last 10 notes by default; --all prints every one, and the NOTES line says how many are hidden
      const notes = await sql`select at, actor, summary from cb.events where task_id = ${n} and kind in ('note', 'done') order by id desc limit ${o.all ? null : 10}`; // limit null = no limit; never a sql`` fragment (the relay bridge cannot carry one)
      const [{ notes_total }] = await sql`select count(*)::int as notes_total from cb.events where task_id = ${n} and kind in ('note', 'done')`;
      const hidden = notes_total > notes.length ? `, ${notes.length} of ${notes_total} shown: cb show ${n} --all for every note` : '';
      const goals = await sql`select g.id, g.title, g.status from cb.goal_tasks gt join cb.goals g on g.id = gt.goal_id
        where gt.task_id = ${n} and gt.state = 'in' and g.status <> 'done' order by g.status, g.rank`;
      const [{ parts }] = await sql`select cb._parts_words(${n}) as parts`; // a parts card (#3703): its parts in plain words
      return { out: [withStage(t), parts && `parts: ${parts}`, ...goals.map((g: any) => `in goal G${g.id} ${flat(g.title)}${g.status === 'paused' ? ' [paused]' : ': comes right after P0'}`),
        t.body && `\n${flat(t.body)}`, notes.length && `\nNOTES (newest first${hidden})`,
        ...notes.map((e: any) => `  ${new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')} ${e.actor}: ${flat(e.summary)}`)]
        .filter(Boolean).join('\n'), json: { ...t, notes, notes_total } };
    }
    case 'search': { // #4339: is it filed already? Run before a cb bug or cb add.
      need(1, 'search [project] "<words>" [--notes] [--all]   e.g. cb search claude-board "relay drops"');
      // two or more words: the first is the project (as cb mem add); one: --project, else this pane's, else every project
      const project = o.project ?? (args.length > 1 ? args[0] : sessionProject);
      const q = (o.project || args.length < 2 ? args : args.slice(1)).join(' ');
      const find = (p: string | null) => callFn('task_find', { q, project: p, notes: !!o.notes, lim: o.all ? null : 20 });
      let r: any = await find(project ?? null).catch((e: any) => {
        // cb search relay drops: the first word was taken as a project, not as the start of the words
        if (o.project || args.length < 2 || !/^unknown project /.test(e?.message ?? '')) throw e;
        throw new Error(`"${args[0]}" is not a project: quote the words, cb search "${args.join(' ')}", or name the project first, cb search <project> "<words>" (known: ${String(e.message).split('known: ')[1] ?? 'none'})`);
      });
      const notesHint = o.notes ? '' : ' (--notes searches the notes too)';
      let head: string[] = [];
      // #660: a pane's inherited project is searched without the session naming it: on no match widen once, and say so.
      // A project the session named (--project, or the first word) stays put.
      if (!r.cards.length && project && !o.project && args.length < 2) {
        const wide: any = await find(null);
        if (!wide.cards.length) return { out: `no card in ${project} or any other project matches "${q}"${notesHint}`, json: wide };
        r = wide;
        head = [`no card in ${project} matches "${q}"; in every project:`];
      } else if (!r.cards.length) return { out: `no card${project ? ` in ${project}` : ''} matches "${q}"${notesHint}`, json: r };
      return { out: [...head, ...r.cards.map((t: any) => line({ ...t, status: t.stage ? `${t.status}, ${t.stage}` : t.status })),
        ...(r.total > r.cards.length ? [`(${r.cards.length} of ${r.total} shown: --all lists every one)`] : [])].join('\n'), json: r };
    }
    case 'mine': {
      const rows: any = await callFn('mine', { actor });
      if (!rows.length) return { out: 'no tasks assigned to ' + actor, json: rows };
      const { open, gone, words } = await mineLines(rows, actor, '');
      // --json (#4513): open false = closed or moved off you in the last 24h, the text's second heading; stage_words as the
      // text prints them (the same one query, #4512)
      return { out: [...(open.length ? open : [`no open tasks assigned to ${actor}`]), ...(gone.length ? ['', ...gone] : [])].join('\n'),
        json: rows.map((t: any, i: number) => ({ ...t, stage_words: words[i], open: openFor(actor)(t) })) };
    }
    case 'ask': {
      need(2, 'ask <project> "<question>" -o "<Label (Recommended)>=<why>" -o "<Label>=<tradeoff>"');
      if (!o.option && !o.free)
        throw new Error('give Ahmed options to click: -o "Label (Recommended)=why" -o "Label=tradeoff" (2-4 of them). ' +
          'Only a question with no possible choices (a fact, a URL, a name) goes as --free.');
      if (o.if && !o.after) throw new Error('--if needs --after: name the question whose answer it waits for, e.g. cb ask <project> "<q>" -o ... --after Q12 --if "Yes"');
      const reply_to = replyTo(), pics = images();
      const body = await fromStdin(args.slice(1).join(' '), 'question'), context = await fromStdin(o.context, 'context');
      const opts = o.option ? options() : null;
      // one transaction: the question never shows on the board without the pictures it was asked with
      let again = false;
      const id = await sql.begin(async (tx) => {
        // #3331: a resend of a question that is still open (the first run stored it, then failed or seemed to) returns
        // that question instead of a second copy. Every field the asker gives must match, with a follow-up's task, reply
        // pane and recipient taken from its parent and the ids read as cb.ask reads them: a wrong match would drop a
        // question, a miss only repeats one. With pictures it always posts: new pictures must never be dropped silently.
        // The lock: a resend while the first run's commit is still in flight waits for it, then sees it.
        if (!pics.length) await tx`select pg_advisory_xact_lock(hashtext(${actor.trim()} || '|' || trim(${body}::text)))`;
        const [dup] = pics.length ? [] : await tx`with a as (
            select case when nullif(trim(${o.after ?? null}::text), '') is null then null
                        else cb.norm_id(regexp_replace(trim(${o.after ?? null}::text), '^[qQ]', '')) end as par,
                   case when nullif(trim(${o.task ?? null}::text), '') is null then null else cb.norm_id(${o.task ?? null}::text) end as tid)
          select q.id from a left join cb.questions p on p.id = a.par cross join cb.questions q
           where q.asked_by = ${actor.trim()} and q.project = cb.resolve(${args[0]}) and q.body = trim(${body}::text)
             and q.options is not distinct from cb._options(${opts && JSON.stringify(opts)}::text::jsonb)
             and q.parent_id is not distinct from a.par
             and (${o.if ?? null}::text is null and q.if_answer is null or lower(q.if_answer) = lower(trim(${o.if ?? null}::text)))
             and q.context is not distinct from ${context ?? null}::text and q.multi = ${!!o.multi} and q.blocking = ${!!o.blocking}
             and q.task_id is not distinct from coalesce(a.tid, p.task_id)
             and q.reply_to is not distinct from coalesce(${reply_to && JSON.stringify(reply_to)}::text::jsonb, p.reply_to)
             and q.assigned_to is not distinct from coalesce(${o.to ?? null}::text, p.assigned_to)
             and q.status in ('open', 'dormant') order by q.id limit 1`;
        if (dup) { again = true; return dup.id; }
        const qid = await callFn('ask', { project: args[0], body, options: opts,
          multi: !!o.multi, blocking: !!o.blocking, task_id: o.task ?? null, context: context ?? null, reply_to, actor, to_user: o.to ?? null,
          parent: o.after ?? null, if_answer: o.if ?? null }, tx);
        await addImages(tx, qid, pics, false);
        return qid;
      });
      // #3331: the question is stored. Nothing after this may turn that into an error (a retry would ask it twice): the
      // reads below only shape the message, so a board that drops now costs their detail, never the exit code.
      const [f] = o.after ? await sql`select parent_id, if_answer from cb.questions where id = ${Number(id)}`
        .catch(() => [{ parent_id: String(o.after).trim().replace(/^[qQ#]+/, ''), if_answer: o.if ?? null }]) : [];
      // #550: without --reply-to the answer goes to the asking name; with no live relay on it, it waits in cb pending.
      let relay_live: boolean | null = null; // --json (#4453): null = not checked (--reply-to given, or the read failed)
      if (!o['reply-to']) try {
        // same 90s as cb.sessions_overview. Written out twice, not as a shared sql`` fragment: a fragment is a Promise
        // and the relay bridge cannot carry one ("#<Promise> could not be cloned", broke every ask with a live relay).
        const [r] = await sql`select exists(select 1 from cb.sessions where actor = ${actor} and last_seen > now() - interval '90 seconds') as live,
          (select actor from cb.sessions where machine = ${machine()} and pane = ${pane} and last_seen > now() - interval '90 seconds') as mine`;
        relay_live = r.live;
        if (!r.live) console.error(`warning: no relay listens on ${actor}, so the answer will wait in cb pending --as ${actor}` +
          (r.mine && r.mine !== actor ? `. This pane's relay is ${r.mine}: ask without --as, or add --reply-to` : ''));
      } catch { /* only a warning: the question is posted either way */ }
      const json = { id, duplicate: again, parent: f ? Number(f.parent_id) : null, if_answer: f?.if_answer ?? null, relay_live };
      if (again) return { out: `Q${id} is already on the board: you asked the same question and it is still open, so it was not posted again` +
        ' — keep working; its answer arrives like any other', json };
      return { out: (f ? `Q${id} posted as a follow-up to Q${f.parent_id}: ` +
          (f.if_answer ? `it opens only if Q${f.parent_id} is answered "${f.if_answer}", else it is skipped` : `it opens once Q${f.parent_id} is answered`) +
          ' — keep working; its answer arrives like any other'
        : `Q${id} posted${pics.length ? ` with ${pics.length} picture${pics.length > 1 ? 's' : ''}` : ''} — keep working; the answer arrives in this session by itself once \`cb relay\` is on, else via \`cb pending\``) +
        (o.free ? `\nPosted with --free: Ahmed must type the answer. If he could pick instead (yes/no, approve?, A or B, who does it), run cb withdraw Q${id} and ask again with -o options (cb help ask).` : ''), json };
    }
    case 'pending': {
      const rows: any = await callFn('answers_pending', { project: args[0] ?? sessionProject });
      const ids = rows.map((q: any) => q.parent_id).filter(Boolean);
      const parents = new Map((ids.length ? await sql`select id, body, answer from cb.questions where id in ${sql(ids)}` : []).map((p: any) => [p.id, p]));
      return { out: rows.length ? rows.map((q: any) => { const p: any = parents.get(q.parent_id);
        if (q.status === 'sent_back') { const by = q.sent_back.by === 'ahmed' ? 'Ahmed' : `${q.sent_back.by} (not Ahmed)`;
          return `Q${q.id} sent back by ${by} to ${q.asked_by}: ${flat(backWhy(q.sent_back.reason, q.sent_back.note?.slice(0, 500)))}` +
            `\n  asked: ${flat(q.body)}\n  rewrite it: ${reaskHint(q.id, q.sent_back.reason)}`; }
        return `Q${q.id} → ${q.asked_by}${q.reply_to?.pane ? ` (pane ${q.reply_to.pane}@${q.reply_to.machine})` : ''}` +
          `${p ? `\n  follow-up to Q${p.id} (answered ${flat(p.answer)}): ${flat(p.body)}` : ''}\n  asked: ${flat(q.body)}\n  answer: ${flat(q.answer)}` +
          (q.answer_history?.length ? `\n  CHANGED: was "${flat(q.answer_history.at(-1).answer)}". Undo or redo what you did based on the old answer.` : ''); }).join('\n')
        : 'no answers waiting', json: rows };
    }
    case 'reask': {
      need(1, 'reask Q<id> ["<new question>"] [-o "<Label>=<why>" ... | --free] [--multi] [-c "<context>"] [-i "<Caption>=<picture>" ...]');
      const id = args[0].replace(/^q/i, ''), pics = images();
      const body = await fromStdin(args.slice(1).join(' ') || null, 'question'), context = await fromStdin(o.context, 'context');
      // new -i pictures replace the old ones (without -i the question keeps its pictures). They go in first:
      // cb.reask sees them in this transaction, which is what a "Show me" send-back needs.
      await sql.begin(async (tx) => {
        await addImages(tx, id, pics, true);
        await callFn('reask', { id, body, options: o.option ? options() : null, free: !!o.free,
          multi: o.multi ? true : null, context: context ?? null, actor }, tx);
      });
      const [w] = await sql`select q.status, q.assigned_to, u.display from cb.questions q left join cb.users u on u.name = q.assigned_to where q.id = ${Number(id)}`;
      return { out: `Q${id} rewritten and back ${w?.display ? `with ${w.display}` : "on Ahmed's board"} — keep working; the answer arrives like any other`,
        json: { id: Number(id), status: w?.status ?? null, assigned_to: w?.assigned_to ?? null } };
    }
    case 'delivered':
      need(1, 'delivered <qid> [session]');
      await callFn('answer_delivered', { id: args[0].replace(/^q/i, ''), delivered_to: args[1] ?? null, actor });
      return { out: `Q${args[0].replace(/^q/i, '')} delivered`, json: { id: Number(args[0].replace(/^q/i, '')), delivered_to: args[1] ?? null } };
    case 'withdraw':
      need(1, 'withdraw <qid>');
      await callFn('withdraw', { id: args[0].replace(/^q/i, ''), actor });
      return { out: `Q${args[0].replace(/^q/i, '')} withdrawn`, json: { id: Number(args[0].replace(/^q/i, '')), status: 'withdrawn' } };
    case 'reply': {
      need(2, 'reply A<id> "<text>" [--done]   e.g. cb reply A12 "B64 graded 27/32" --done');
      const id = args[0].replace(/^a/i, '');
      await callFn('ask_reply', { id: args[0], message: args.slice(1).join(' '), done: !!o.done, actor });
      return { out: `replied to A${id}${o.done ? `; A${id} closed` : ': Ahmed reads it on Today (more: cb reply again; the last one with --done)'}`,
        json: { id: Number(id), closed: !!o.done } };
    }
    case 'asks': {
      if (args[0] === 'add') { // #951: what Ahmed asked in this terminal, onto the board so the reply lands on Today
        need(2, 'asks add "<what Ahmed asked you>" [-t <task>]   e.g. cb asks add "Why is B64 at 27/32?"');
        const id = await callFn('ask_record', { body: args.slice(1).join(' '), task: o.task ?? null, project: sessionProject ?? null, actor });
        return { out: `A${id} recorded (asked in your terminal): reply on the board with cb reply A${id} "<reply>" (--done with the final one)`,
          json: { id: Number(id), task: o.task == null ? null : Number(String(o.task).replace('#', '')) } };
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
      if (!project) throw new Error('no project: say which (cb tick iris) or bind this session once (cb iam <name> <project>)');
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
    case 'digest': {
      const project = args[0] ?? sessionProject;
      if (!project) throw new Error('no project: say which (cb digest iris) or bind this session once (cb iam <name> <project>)');
      const lines: any = await callFn('digest', { project, cap: !o.all });
      return { out: lines.join('\n'), json: lines };
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
      throw new Error(unknownCommand(cmd!));
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
  if (namesCommand(m) || /keep working/i.test(m)) return m; // #4515: "Keep working meanwhile." too (a lost read names no check)
  // never "cb help help": it is the command that just failed (#4755). A message that ends a sentence takes no extra dot
  return `${m}${/[.?!]$/.test(m) ? '' : '.'} Run: cb help${cmd && cmd !== 'help' && Object.hasOwn(COMMANDS, cmd) ? ` ${cmd}` : ''}`;
}

/** #4754 (and #4738 for edit): a flag the command does not read was dropped and the command ran, so --dry-run did the
 *  real thing. Refused before the command starts. */
function refuseUnread() {
  if (!cmd || !Object.hasOwn(COMMANDS, cmd)) return; // an unknown command has its own message
  const shorts = Object.fromEntries(Object.entries(OPTIONS).flatMap(([name, v]: [string, any]) => (v.short ? [[v.short, name]] : [])));
  const takes = flagsOf(cmd, shorts);
  const sub = cmd === 'squad' && args[0] ? ` ${args[0]}` : '';
  if (cmd === 'squad' && !['up', 'trust'].includes(args[0] ?? '')) takes.delete('dry-run'); // squad set writes
  const extra = Object.keys(o).filter((k) => !takes.has(k));
  if (!extra.length) return;
  const id = String(args[0] ?? '<id>').replace('#', '');
  // status and a PR have their own places: say where, since an agent that typed them means them
  const how = cmd === 'edit' && o.status !== undefined ? `For a status run: cb move ${id} ${o.status} (to finish a card: cb done)`
    : cmd === 'move' && o.pr !== undefined ? `Put the PR in the note: cb move ${id} review "PR <url>"`
    : `Run: cb help ${cmd}`;
  throw new Error(`cb ${cmd}${sub} does not take ${extra.map((k) => `--${k}`).join(', ')}: nothing was changed. ${how}`);
}

async function main() {
  if (o.help) { console.log(help(cmd) ?? help()); return; }
  refuseUnread();
  let r: any;
  try {
    r = await run();
  } catch (e: any) {
    fault.error(e);
    // cb start is advice: it always exits 0 and never starts Postgres (e.g. the Mac while this PC sleeps)
    if (cmd === 'start') {
      const why = String(e?.code ?? e?.message ?? e);
      console.log(o.json ? JSON.stringify({ board: 'unreachable', error: why }, null, 2) : `board unreachable: keep working and register this later. Retry: cb start (${why})`);
      return;
    }
    // Whether the command ran is said plainly (#4337): a resend of one that may have run does it twice (#3331).
    // #4515: a command that only reads saved nothing, whichever of its steps the board answered: running it again is safe
    const reads = onlyReads(cmd, args);
    const ran = ranWords(e, reads ? 0 : sql.answered ?? 0, checkFirst(cmd, args, actor));
    if (!ran) throw e;
    const tried = e.tries ? `, tried ${e.tries} times over ${Math.round(e.triedMs / 1000)} s` : '';
    // a read on a board on another machine exits 3 too, connection lost or not (this machine's own board never gives 3)
    const again = !localBoard && reads ? { exit: 3 } : {};
    // the connection dropped after a statement was sent (reset, closed, the relay lost): the board may have run it
    if (!neverSent(e)) throw Object.assign(new Error(`lost the board connection at ${boardHost} (${e.code}): ${ran}. Keep working meanwhile.`), again);
    // A remote board (another machine) can't be started from here: say so and let the session carry on.
    // exit 3 (#4450): nothing of the command reached the board (the retry wrapper counts what it answered; it wraps
    // every remote board), so a script may run it again unchanged; so may a read (#4515). Exit 1 when it may have run.
    if (!localBoard) throw Object.assign(new Error(`board unreachable at ${boardHost} (${e.code}${tried}): ${ran}. The board machine may be asleep: keep working and register this later.`),
      sql.answered === 0 ? { exit: 3 } : again);
    if (e.code !== 'ECONNREFUSED') throw e;
    // only the board's own cluster (5434): a worktree test cluster's port must not start .pgdata on 5434 (#4413)
    const pg = await import('../db/pg.ts');
    // say so in words: a refused 'localhost' (both ::1 and 127.0.0.1) is an AggregateError with an empty message
    const port = new URL(databaseUrl()).port || '5432';
    if (!pg.ownsPg(databaseUrl())) throw new Error(`board refused the connection at ${boardHost}:${port} (ECONNREFUSED): ${ran}. Is Postgres running there?`);
    pg.ensurePg();
    fault.localStart();
    r = await run();
  }
  if (o.json && 'json' in r) console.log(JSON.stringify(r.json, null, 2));
  else if (r.out) console.log(r.out);
  if (r.code) { fault.answer(); process.exitCode = r.code; }
}

try {
  await main();
} catch (e: any) {
  fault.error(e);
  console.error(`cb: ${actionable(String(e?.message ?? e))}`);
  process.exitCode = e?.exit ?? 1;
} finally {
  await sql.end({ timeout: 1 });
}
