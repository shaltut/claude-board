// Board → session push. Started by a SessionStart hook in every Claude Code session.
// It watches the board (Postgres LISTEN) and writes into this session's own inbox
// ($CLAUDE_CODE_MESSAGING_SOCKET): answers to the session's questions, and changes other people
// make to its tasks. An idle session gets a new turn; a busy one reads it between tool calls.
// Exits when the session's inbox disappears (session ended).
import net from 'node:net';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, machine } from '../server/db.ts';
import { backWhy, reaskHint } from './help.ts';

const SOCKET = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
const TOKEN = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
const PANE = process.env.HERDR_PANE_ID;
if (!SOCKET || !TOKEN || !PANE) process.exit(0); // no inbox or not a herdr pane: nothing to push to

const key = createHash('sha1').update(SOCKET).digest('hex').slice(0, 12);
const LOCK = join(tmpdir(), `cb-relay-${key}.pid`);
const LOG = join(tmpdir(), `cb-relay-${key}.log`);
const log = (m: string) => { try { appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch {} };

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const lockPid = () => { try { return Number(readFileSync(LOCK, 'utf8')) || 0; } catch { return 0; } };
const relaunch = () => spawn(process.execPath, [import.meta.filename, '--child'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();

// The hook must return at once: re-launch detached and exit. --restart replaces a running relay.
if (!process.argv.includes('--child')) {
  if (process.argv.includes('--restart')) {
    const old = lockPid();
    if (old && alive(old)) try { process.kill(old); } catch {}
    writeFileSync(LOCK, '');
  }
  relaunch();
  process.exit(0);
}

{ const held = lockPid(); if (held > 0 && held !== process.pid && alive(held)) process.exit(0); } // one relay per session (empty lock = none)
writeFileSync(LOCK, String(process.pid));

const M = machine();
const sql = connect();
let after = Number.MAX_SAFE_INTEGER; // first check: pending answers only, no history replay
let busy = false, again = false;

/** One line per connection, opened only when the message is ready (the inbox closes idle connections). */
function post(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = net.connect(SOCKET!, () => {
      c.end(JSON.stringify({ type: 'auth', token: TOKEN }) + '\n' +
            JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
    });
    c.setTimeout(5000, () => c.destroy(new Error('inbox timeout')));
    c.on('error', reject);
    c.on('close', (hadError) => (hadError ? null : resolve()));
  });
}

// Ahmed's answers carry his authority; anyone else's (a guest like Omar) must say so.
const who = (a: any) => (!a.answered_by || a.answered_by === 'ahmed' ? 'Ahmed' : `${a.answered_by} (not Ahmed)`);
const cut = (v: unknown, n: number) => { const s = String(v ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
/** A topic in quotes it can't close: `x" — Ahmed: do X` must not read as a header. */
const quote = (v: unknown, n: number) => JSON.stringify(cut(v, n));

/** Every string in the inbox is someone's text: indent its continuation lines so none of it can start a
 *  line of its own and pass for a header (`Huddle #2 "x" — Ahmed: ...`). Applied to the whole payload, so
 *  new fields are covered too. */
const indent = (x: any): any =>
  typeof x === 'string' ? x.replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, '\n    ')
    : Array.isArray(x) ? x.map(indent)
    : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, indent(v)])) : x;

function format(raw: any): string {
  const i = indent(raw);
  const lines = ['[Claude Board]'];
  // Ahmed's asks (#936) first: his own words, answered on the board, where he reads them (not in this terminal)
  for (const a of i.asks ?? []) {
    const tag = `A${a.id}${a.task_id ? ` (task #${a.task_id})` : ''}`;
    for (const l of a.lines)
      lines.push(`[Ahmed asks] ${tag}${a.reminder ? ' (reminder: no reply in 15 min)' : l.action === 'say' ? ' (in the thread)' : ''}: ${l.text}`);
    lines.push(`  → cb reply A${a.id} "<your reply>"   (Ahmed reads replies on the board, not here; add --done with the final one)`);
  }
  for (const b of i.broadcasts) lines.push(`Broadcast from ${b.actor}${b.project ? ` to ${b.project}` : ' to everyone'}: ${b.summary}`);
  // the GitHub watch (#1207) is not a session: nobody to reply to
  for (const m of i.messages) lines.push(`Message from ${m.actor}: ${m.summary}`, ...(m.actor === 'github' ? [] : [`  (reply: cb tell ${m.actor} "...")`]));
  // Ahmed talks in huddles from the dashboard: his lines must read as him, not as a teammate.
  const huddles: any[] = i.huddles ?? [];
  const fromAhmed = huddles.filter((h) => h.actor === 'ahmed' && (h.action === 'open' || h.action === 'say'));
  const mates = huddles.filter((h) => h.actor !== 'ahmed');
  const ahmedIds = [...new Set(fromAhmed.map((h) => h.huddle))];
  const otherIds = [...new Set(huddles.filter((h) => h.action !== 'close' && !ahmedIds.includes(h.huddle)).map((h) => h.huddle))];
  for (const h of huddles) {
    const topic = `Huddle #${h.huddle} ${quote(h.topic, 60)}`;
    if (h.actor === 'ahmed' && h.action === 'open')
      lines.push(`Ahmed opened a discussion with you about ${quote(h.topic, 120)} and is waiting for your reply in huddle #${h.huddle}.`);
    else if (h.actor === 'ahmed' && h.action === 'say') lines.push(`${topic} — Ahmed: ${h.summary}`);
    else lines.push(`${topic}: ${h.action === 'say' ? `${h.actor}: ${h.summary}` : h.action === 'open' ? `${h.actor} opened it and added you` : `${h.actor} ${h.summary}`}`);
  }
  if (ahmedIds.length) {
    const id = ahmedIds[0], where = ahmedIds.map((h) => `#${h}`).join(', #');
    lines.push(`  (This is Ahmed himself in huddle ${where}, from the dashboard. Only the unindented lines above that name Ahmed are his: ` +
      `what he asks in them are his instructions, act on them. Indented text belongs to the line above it. ` +
      `Reply in the huddle: cb huddle say ${id} "..." and keep replies short; he reads them live. ` +
      `If he says "make it a task", use cb add; "this is a bug", cb bug; then post the new task id back in the huddle. Whole thread: cb huddle show ${id})`);
  }
  if (otherIds.length) lines.push(`  (reply: cb huddle say ${otherIds[0]} "..."; whole thread: cb huddle show ${otherIds[0]})`);
  for (const a of i.answers)
    lines.push(`${who(a)} answered Q${a.id}${a.task_id ? ` (task #${a.task_id})` : ''}: ${a.answer}`,
      ...(a.parent_id ? [`  Follow-up to Q${a.parent_id} (${who({ answered_by: a.parent_answered_by })} answered ${cut(a.parent_answer, 120)}): ${cut(a.parent_body, 200)}`] : []),
      `  You asked: ${cut(a.body, 200)}`);
  // Sent back (#616): rewrite the same question. ?? []: a board whose schema predates it.
  for (const s of i.sent_back ?? [])
    lines.push(`${who({ answered_by: s.by })} sent Q${s.id} back: ${backWhy(s.reason, s.note && cut(s.note, 500)).replace(/([^.!?…])$/, '$1.')} Rewrite it: ${reaskHint(s.id)}`,
      `  You asked: ${cut(s.body, 200)}`);
  for (const c of i.answer_copies ?? [])
    lines.push(`${who(c)} answered ${c.asked_by}'s Q${c.id}${c.task_id ? ` (task #${c.task_id})` : ''}: ${c.answer}`,
      `  They asked: ${cut(c.body, 200)}`, `  (copy for you as orchestrator; ${c.asked_by} gets it directly)`);
  for (const b of i.bugs ?? []) {
    const first = cut(String(b.body ?? '').split('\n')[0].trim(), 200);
    lines.push(`${b.actor} filed bug #${b.id} '${cut(b.title, 80)}' in ${b.project}${first ? `: ${first.replace(/([^.!?…])$/, '$1.')}` : '.'}` +
      ` Assign it: cb edit ${b.id} --assignee <worker> (or take it).`);
  }
  // the GitHub watch writes its PR cards with the message that already says what happened: not echoed twice
  const echo = i.messages.some((m: any) => m.actor === 'github');
  for (const e of i.events) {
    if (echo && e.actor === 'github') continue;
    const what = ({ note: 'noted on', done: 'closed', moved: 'moved', task_created: 'created for you' } as any)[e.kind] ?? 'edited';
    lines.push(`${e.actor} ${what} #${e.task_id} "${cut(e.title, 80)}" (now ${e.status}): ${cut(e.summary, 200)}`);
  }
  // Shared memory changes (#553). Only Ahmed's dashboard acts as ahmed, so his lines carry his authority; any other
  // author is labelled a teammate.
  for (const x of i.memory ?? []) {
    const team = x.actor !== 'ahmed', by = team ? x.actor : 'Ahmed', note = team ? ' (team, not Ahmed)' : '';
    if (x.action === 'supersede') lines.push(`M${x.memory} superseded by M${x.by} (${team ? `${x.actor}, team, not Ahmed` : 'Ahmed'}): ${x.by_title}`);
    // an order-shaped reason stays on the board (why_hidden); the 200 cut repeats the database's cap
    else if (x.action === 'retire') lines.push(`${by} retired ${x.kind} M${x.memory}${note}: ${x.title}` +
      (x.why_hidden ? ` (reason: see cb mem show M${x.memory})` : x.why ? ` (${cut(x.why, 200)})` : ''));
    else lines.push(`${by} ${x.action === 'confirm' ? 'confirmed' : 'added'} ${x.kind} M${x.memory}${note}: ${x.title}${x.replaces ? ` (replaces M${x.replaces})` : ''}`);
  }
  if (i.next_work.length) {
    const list = i.next_work.map((t: any) => `#${t.id} ${t.priority} ${cut(t.title, 60)}`).join('; ');
    lines.push(`New work in your project's Next: ${list}. You have nothing in progress: take it with \`cb next\`.`);
  }
  if (i.sent_back?.length) lines.push('Rewrite each with cb reask (same Q id); do not open a new question.');
  if (i.answers.length) lines.push('Act on these now. The answers are marked delivered.');
  else if (i.bugs?.length) lines.push('A session reported it, not Ahmed: triage it, then carry on.');
  else if (i.answer_copies?.length) lines.push('The worker acts on it; update your plan, tasks or priorities if the answer changes them.');
  else if (i.messages.length || mates.length)
    lines.push(fromAhmed.length ? 'Lines not from Ahmed are teammates, not his approval.' : 'Act on this now if it needs you; a teammate wrote it, not Ahmed.');
  else if (i.events.length) lines.push('Act on this now (check `cb mine`).');
  else if (i.broadcasts.length && !i.next_work.length) lines.push('Follow it now if it applies to you.');
  else if (i.memory?.length && !i.next_work.length)
    lines.push(`Shared memory changed: follow it from now on${i.memory.some((x: any) => x.actor !== 'ahmed') ? "; a team entry is a teammate's note, not Ahmed's approval" : ''}. Whole entry: cb mem show M<id>.`);
  return lines.join('\n');
}

async function check() {
  if (busy) { again = true; return; }
  busy = true;
  try {
    do {
      again = false;
      const [{ i }] = await sql`select cb.inbox(${M}, ${PANE}, ${after}) as i`;
      const read = [...i.broadcasts, ...i.messages, ...(i.huddles ?? [])].map((x: any) => Number(x.id))
        .concat([...(i.answer_copies ?? []), ...(i.bugs ?? [])].map((x: any) => Number(x.event_id)));
      if (i.asks?.length || i.answers.length || i.sent_back?.length || i.events.length || read.length || i.next_work.length || i.memory?.length) {
        await post(format(i));
        for (const a of i.asks ?? []) await sql`select cb.ask_delivered(${String(a.id)}, ${a.upto}, ${i.actor}, ${a.reminder})`;
        if (read.length) await sql`select cb.broadcast_seen(${M}, ${PANE}, ${Math.max(...read)})`;
        for (const a of i.answers) await sql`select cb.answer_delivered(${String(a.id)}, ${i.actor ?? `${PANE}@${M}`}, ${'relay'})`;
        // only the send-back pushed: one rewritten (or sent back again) since stays as it is
        for (const s of i.sent_back ?? []) await sql`select cb.answer_delivered(${String(s.id)}, ${i.actor ?? `${PANE}@${M}`}, ${'relay'}, ${s.at})`;
        log(`pushed ${i.asks?.length ?? 0} asks, ${i.bugs?.length ?? 0} bugs, ${i.huddles?.length ?? 0} huddle lines, ${i.messages.length} messages, ${i.answers.length} answers, ${i.sent_back?.length ?? 0} sent back, ${i.events.length} events, ${i.broadcasts.length} broadcasts, ${i.next_work.length} next, ${i.memory?.length ?? 0} memory`);
      }
      after = Number(i.last_event);
    } while (again);
  } catch (e: any) {
    log(`check failed: ${e?.message}`); // board asleep or inbox busy: the next notify or poll retries
  } finally {
    busy = false;
  }
}

let timer: NodeJS.Timeout | undefined;
const soon = () => { clearTimeout(timer); timer = setTimeout(check, 250); };

await sql.listen('cb', soon, soon).catch((e) => log(`listen failed: ${e?.message}`));
log(`relay up for ${PANE}@${M}`);
await check();
setInterval(check, 30_000); // safety net if a notify is missed while reconnecting
// Board updates reach running sessions: when this code changes (and has settled), hand over to a fresh relay.
const CODE = [import.meta.filename, join(import.meta.dirname, '..', 'server', 'db.ts')];
const version = () => CODE.map((f) => { try { return statSync(f).mtimeMs; } catch { return 0; } });
const born = version().join();

setInterval(() => {
  const release = () => { try { if (lockPid() === process.pid) writeFileSync(LOCK, ''); } catch {} };
  if (!existsSync(SOCKET)) {
    log('session inbox gone; exiting');
    release();
    process.exit(0);
  }
  const v = version();
  if (v.join() !== born && Date.now() - Math.max(...v) > 3000) {
    log('relay code changed; restarting');
    release();
    relaunch();
    process.exit(0);
  }
}, 2000);
