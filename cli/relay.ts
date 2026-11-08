// Board → session push. Started by a SessionStart hook in every Claude Code session.
// It watches the board (Postgres LISTEN) and writes into this session's own inbox
// ($CLAUDE_CODE_MESSAGING_SOCKET): answers to the session's questions, and changes other people
// make to its tasks. An idle session gets a new turn; a busy one reads it between tool calls.
// Exits when the session's inbox disappears (session ended).
import net from 'node:net';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, machine } from '../server/db.ts';

const SOCKET = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
const TOKEN = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
const PANE = process.env.HERDR_PANE_ID;
if (!SOCKET || !TOKEN || !PANE) process.exit(0); // no inbox or not a herdr pane: nothing to push to

const key = createHash('sha1').update(SOCKET).digest('hex').slice(0, 12);
const LOCK = join(tmpdir(), `cb-relay-${key}.pid`);
const LOG = join(tmpdir(), `cb-relay-${key}.log`);
const log = (m: string) => { try { appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch {} };

// The hook must return at once: re-launch detached and exit.
if (!process.argv.includes('--child')) {
  spawn(process.execPath, [import.meta.filename, '--child'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  process.exit(0);
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
try { if (alive(Number(readFileSync(LOCK, 'utf8')))) process.exit(0); } catch {} // one relay per session
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

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function format(i: any): string {
  const lines = ['[Claude Board]'];
  for (const b of i.broadcasts) lines.push(`Broadcast from ${b.actor}${b.project ? ` to ${b.project}` : ' to everyone'}: ${b.summary}`);
  for (const a of i.answers)
    lines.push(`Ahmed answered Q${a.id}${a.task_id ? ` (task #${a.task_id})` : ''}: ${a.answer}`, `  You asked: ${cut(a.body, 200)}`);
  for (const e of i.events) {
    const what = e.kind === 'note' ? 'noted on' : e.kind === 'done' ? 'closed' : e.kind === 'moved' ? 'moved' : 'edited';
    lines.push(`${e.actor} ${what} #${e.task_id} "${cut(e.title, 80)}" (now ${e.status}): ${cut(e.summary, 200)}`);
  }
  lines.push(i.answers.length ? 'Act on these now. The answers are marked delivered.'
           : i.events.length ? 'Act on this now (check `cb mine`).' : 'Follow it now if it applies to you.');
  return lines.join('\n');
}

async function check() {
  if (busy) { again = true; return; }
  busy = true;
  try {
    do {
      again = false;
      const [{ i }] = await sql`select cb.inbox(${M}, ${PANE}, ${after}) as i`;
      if (i.answers.length || i.events.length || i.broadcasts.length) {
        await post(format(i));
        if (i.broadcasts.length) await sql`select cb.broadcast_seen(${M}, ${PANE}, ${i.broadcasts.at(-1).id})`;
        for (const a of i.answers) await sql`select cb.answer_delivered(${String(a.id)}, ${i.actor ?? `${PANE}@${M}`}, ${'relay'})`;
        log(`pushed ${i.answers.length} answers, ${i.events.length} events, ${i.broadcasts.length} broadcasts`);
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
setInterval(() => {
  if (existsSync(SOCKET)) return;
  log('session inbox gone; exiting');
  try { if (readFileSync(LOCK, 'utf8') === String(process.pid)) writeFileSync(LOCK, ''); } catch {}
  process.exit(0);
}, 2000);
