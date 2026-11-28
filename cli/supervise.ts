// The supervisor (#3601): `node cli/supervise.ts`, started with `cb supervise` in herdr tab `supervisor` on the PC.
// Every 60 s one tick: per supervised project it starts, restores and closes squad sessions through herdr as planTick
// says; for every project with a squad that gets work it tells the lead of a seat stopped by its model's quota, and where
// Ahmed turned automatic backup on it moves a seat still stopped at the next check to its squad's backup (#4787);
// then it restarts the PC runner if it stopped beating. One supervisor anywhere: a Postgres advisory lock.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect, machine } from '../server/db.ts';
import { loadConfig } from './recipes.ts';
import { classifyAgentGet, find, herdrJson, herdrName, launchSpec, promptCommand, realRun, runsOn, seatSpec, startOne, wantList, type Launch, type Runner } from './squad-up.ts';
import { mayBeLeaving, nextBackup, onBackups, pastSeatNames, planTick, quotaChecks, quotaWatched, windDownQuiet, type Leaving, type Session, type State, type TickPlan } from './supervise-plan.ts';
import { getAdapter } from './agents/index.ts';
import { DeadlineError, withDeadline } from './deadline.ts';
import type { AgentAdapter, QuotaSignal, SeatHandle } from './agents/types.ts';

const TICK_MS = 20 * 60_000;
const MAC = 'macbook', STARTS_PER_TICK = 3, RUNNER_STALE = 3 * 60_000, RUNNER_RETRY = 10 * 60_000, HOUR = 3_600_000, CLOSE_WAIT = 60_000, POLL = 5_000,
  CLOSE_RETRY = 10 * 60_000;
const BOARD = join(import.meta.dirname, '..'); // the board checkout on this PC: the runner tab's folder

// launched: names this run started or restored that the board has not yet seen live (planTick counts them as started)
// closeSkipAt: names herdr lists but could not find for a close (an unnamed pane), skipped 10 minutes
// elsewhereToldAt: per project, when "its PC is another machine" was last said; runnerPane: the runner tab this run opened
// leavingTold (#3770): per leaving seat, the reason last said in the log: said again only when it changes
// restartTried (#4332): per seat, the setting this run closed it to restart on, or refused: planTick's restartTried
// unreadTold (#4787): seats whose screen could not be checked for a quota stop: said again only after it could be
export type Memory = { failedAt: Map<string, number>; blockedTold: Set<string>; launched: Set<string>; runnerToldAt: number; runnerStartedAt: number;
  closeSkipAt: Map<string, number>; elsewhereToldAt: Map<string, number>; leavingTold: Map<string, string>; restartTried: Map<string, string>;
  unreadTold: Set<string>; runnerPane?: { pane: string; terminal?: string } };
export type Deps = {
  sql: any; run: Runner; dryRun: boolean; now: number; memory: Memory; runnerConfig: string | null;
  probe: (host: string, port: number) => Promise<boolean>; sleep?: (ms: number) => Promise<void>; clock?: () => number;
  // #4261: aborted when the loop gives up on this tick (its deadline): checked before every step that acts
  signal?: AbortSignal;
};
// #4559: a project winding down closes at most this many seats a tick: each close waits up to a minute for herdr, and
// the tick has a deadline
const WIND_DOWN_CLOSES = 2;
// #4787: at most this many seats move to a backup per project a tick; each also takes one of the tick's starts
const SWITCHES = 2;
type Switch = { n: number; from: string; launch: Launch; lead?: string };
const msg = (e: unknown) => ((e as Error)?.message ?? String(e)).trim();

/** One tick. Returns the lines to print. Dry run: herdr is only read (the agent list, and the screens a quota check
 *  reads), the board is never written. */
export async function tick(d: Deps): Promise<string[]> {
  const { sql, run, dryRun, now, memory } = d;
  const out: string[] = [];
  const log = async (project: string | null, what: string, session: string, note?: string) => {
    try { await sql`select cb.supervise_log(${project}, ${what}, ${session}, ${note ?? null})`; } catch (e) { out.push(`could not log ${what} ${session}: ${msg(e)}`); }
  };
  const states: State[] = [];
  for (const { slug } of await sql`select slug from cb.projects where squad is not null order by slug`) {
    try {
      const s = (await sql`select cb.supervise_state(${slug}) as s`)[0].s as State;
      // #4787: every project that gets work is checked for quota stops; only a supervised or winding-down one is acted on
      if (!s.supervised && !s.winding_down && !quotaWatched(s)) continue;
      // herdr null = the machine the supervisor runs on: a squad that puts it elsewhere is not this supervisor's
      const pc = Object.entries(s.squad.machines).find(([k, m]) => m.herdr === null && k.toLowerCase() !== machine())?.[0];
      if (pc === undefined) { states.push(s); continue; }
      if (now - (memory.elsewhereToldAt.get(slug) ?? -Infinity) >= HOUR) {
        memory.elsewhereToldAt.set(slug, now);
        out.push(`${slug}: skipped: its squad's own machine (herdr null) is ${pc}, this is ${machine()}`);
      }
    } catch (e) { out.push(`${slug}: could not read its state: ${msg(e)}`); }
  }

  // herdr: one agent list per herdr label (null = this PC) used by any of those squads
  const keysOf = new Map<string | null, Set<string>>();
  for (const s of states) for (const [k, m] of Object.entries(s.squad.machines)) (keysOf.get(m.herdr) ?? keysOf.set(m.herdr, new Set()).get(m.herdr)!).add(k);
  const herdrLive = new Set<string>(), herdrDown = new Set<string>(), mac = new Set<string>(), herdrStatus: Record<string, string> = {};
  const herdrPane: Record<string, string> = {};
  let macAgents = 0;
  for (const [label, keys] of keysOf) {
    let agents: any;
    try { agents = find(herdrJson(run, label, ['agent', 'list'], 30_000), 'agents'); } catch {}
    if (!Array.isArray(agents)) {
      for (const k of keys) herdrDown.add(k);
      out.push(`herdr ${label ?? 'on this PC'} did not answer: nothing starts there this tick`);
      continue;
    }
    for (const a of agents) if (typeof a?.name === 'string') {
      herdrLive.add(a.name); herdrStatus[a.name] = String(a.agent_status);
      if (typeof a.pane_id === 'string') herdrPane[a.name] = a.pane_id;
      if (label === MAC) mac.add(a.name);
    }
    if (label === MAC) macAgents = agents.length;
  }
  // the Mac cap counts every live session there, any project (as cb squad up)
  const macKeys = new Set([MAC, ...(keysOf.get(MAC) ?? [])]);
  for (const l of await sql`select actor, machine from cb.sessions where last_seen > now() - interval '90 seconds'`) {
    if (macKeys.has(l.machine) || macKeys.has(String(l.actor).split('@')[1])) mac.add(herdrName(l.actor));
  }
  let macLive = Math.max(mac.size, macAgents), startsLeft = STARTS_PER_TICK;
  // a launch stops counting as "started, not bound yet" once the board sees it live, or herdr no longer runs it; a
  // later block of the same name tells the lead again
  const liveOnBoard = new Set(states.flatMap((s) => s.sessions.filter((x) => x.live).map((x) => x.actor)));
  if (!dryRun) {
    for (const n of memory.launched) {
      if (liveOnBoard.has(n) || (!herdrLive.has(herdrName(n)) && !herdrDown.has(n.split('@')[1]!))) { memory.launched.delete(n); memory.blockedTold.delete(n); }
    }
  }

  for (const state of states) {
    d.signal?.throwIfAborted();
    try {
      // before act: a start can take minutes. The switches it returns are carried out by act
      const switches = await quotaStops(d, state, { status: herdrStatus, pane: herdrPane, down: herdrDown }, startsLeft, out);
      if (!state.supervised && !state.winding_down) continue; // nothing below is for a squad the supervisor does not run
      const asRun = onBackups(state); // #4787: a seat on a backup is started, restored and restarted on it
      const safeToClose = await safeToCloseOf(state, herdrStatus);
      // #3770: the names earlier saved versions of the squad generated (cb.squad_set's 'squad updated' events, the last
      // 20), read only when a live or holding session is one the squad does not want now (events has no project index)
      const pastSeats = mayBeLeaving(state, herdrLive) ? pastSeatNames(state.project, (await sql`select e.data -> 'squad' as squad from cb.events e
        where e.project = ${state.project} and e.kind = 'updated' and e.summary = 'squad updated' order by e.id desc limit 20`).map((r: any) => r.squad)) : new Set<string>();
      startsLeft -= switches.length;
      const plan = planTick({ state: asRun, herdrLive, herdrStatus, herdrDown, launched: memory.launched, macLive, startsLeft, failedAt: memory.failedAt, now, safeToClose, pastSeats,
        restartTried: memory.restartTried, startProblem });
      // a seat being switched is closed and started by the switch alone
      const moving = new Set(switches.map((x) => x.launch.name));
      plan.close = plan.close.filter((n) => !moving.has(n));
      plan.restart = plan.restart.filter((x) => !moving.has(x.launch.name));
      plan.restore = plan.restore.filter((l) => !moving.has(l.name));
      plan.start = plan.start.filter((l) => !moving.has(l.name));
      const launches = [...plan.restore, ...plan.start];
      startsLeft -= launches.length + plan.restart.length; // a restart's close frees its own Mac slot: macLive stays
      macLive += launches.filter((l) => l.herdr === MAC || l.machine === MAC).length;
      await act(d, asRun, plan, switches, out, log);
    } catch (e) {
      out.push(`${state.project}: tick failed: ${msg(e)}`);
    }
  }
  const leads = [...new Set(states.filter((s) => s.supervised).map(leadOf).filter((x) => x !== undefined))]; // a project that gets no work is not told
  d.signal?.throwIfAborted();
  try { await runnerCheck(d, out, log, leads); } catch (e) { out.push(`runner check failed: ${msg(e)}`); }
  return out;
}

type Log = (project: string | null, what: string, session: string, note?: string) => Promise<void>;

// The seat of a session, as its agent adapter reads it (#4002): the board's machine and pane, herdr's name and label
const seatOf = (state: State, actor: string, agent: AgentAdapter['kind'], pane: string | null, machine?: string | null): SeatHandle => ({
  machine: machine ?? actor.split('@')[1] ?? '', pane: pane ?? '', actor, agent, herdrName: herdrName(actor),
  herdr: state.squad.machines[actor.split('@')[1] ?? '']?.herdr ?? null });

// Whether each session may be closed now, by its own agent's adapter (#4002). An agent with no adapter yet: never.
async function safeToCloseOf(state: State, herdrStatus: Record<string, string>): Promise<Record<string, boolean>> {
  const safe: Record<string, boolean> = {};
  for (const s of state.sessions) {
    const hn = herdrName(s.actor);
    try {
      const a = getAdapter(s.agent ?? 'claude');
      safe[s.actor] = (await a.readStatus(seatOf(state, s.actor, a.kind, s.pane, s.machine), Object.hasOwn(herdrStatus, hn) ? { agent_status: herdrStatus[hn] } : null)).safeToClose;
    } catch { safe[s.actor] = false; }
  }
  return safe;
}
// #4787: how much of a seat's screen is read (soft wraps joined), and how many of its last non-empty lines are judged:
// a stopped CLI's message sits just above its input box and status lines; anything higher is the seat's own output
const READ_LINES = 40, TAIL_LINES = 15;
export const paneTail = (text: string) => text.split(/\r?\n/).filter((l) => l.trim()).slice(-TAIL_LINES).join('\n');

/** #4787: reads the screen of each seat that is not working and asks its agent's adapter whether a quota stopped it (a
 *  rate limit the CLI retries is no stop). A stop is put on the board once, until the seat acts there again, binds anew
 *  or is switched, and the lead is told; the digest carries it too. Where automatic backup is on (a supervised squad,
 *  never the lead), a stop already on the board is a second sighting with nothing done there in between: it is returned
 *  as a switch, at most SWITCHES and no more than the tick has starts for; with no backup left that is said once
 *  instead. No pane text reaches the board. */
async function quotaStops(d: Deps, state: State, herdr: { status: Record<string, string>; pane: Record<string, string>; down: Set<string> }, room: number, out: string[]) {
  const switches: Switch[] = [];
  for (const s of quotaChecks(state, herdr.status, herdr.down)) {
    d.signal?.throwIfAborted();
    const m = state.squad.machines[s.actor.split('@')[1]!]?.herdr ?? null, hn = herdrName(s.actor), pane = herdr.pane[hn];
    try {
      const a = getAdapter(s.agent ?? 'claude');
      if (!pane) throw new Error('herdr lists it with no pane');
      const r = d.run(m, ['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', String(READ_LINES), '--format', 'text'], 15_000);
      if (r.status !== 0) throw new Error((r.error?.message || r.stderr || 'herdr failed').trim().slice(0, 200));
      const tail = paneTail(r.stdout ?? '');
      const stop: QuotaSignal | null = a.detectQuotaStop(seatOf(state, s.actor, a.kind, pane, s.machine), { agent_status: herdr.status[hn] }, tail);
      d.memory.unreadTold.delete(s.actor);
      if (stop?.kind !== 'quota') continue;
      const lead = leadOf(state), isLead = s.role === 'lead' || s.actor === lead, toTell = isLead ? undefined : lead;
      const want = wantList(state.project, state.squad).find((w) => w.name === s.actor);
      // the seat that may be switched: the switch applies, and the words stand where the CLI prints its own limit message
      // (a seat whose own output quotes them is only told of)
      const applies = state.supervised && !!state.auto_backup && !isLead, banner = a.atQuotaBanner(tail);
      const seat = applies && banner ? want : undefined;
      const next = seat ? nextBackup(state.project, state.squad, seat, s, startProblem) : null;
      if (s.quota_told) {
        if (!seat) continue;
        if (next) {
          if (switches.length < Math.min(SWITCHES, room)) switches.push({ ...next, from: runsOn(s.backup ?? seatSpec(state.squad, seat)), lead: toTell });
          continue;
        }
        if (s.no_backup_told) continue;
      }
      const what = s.quota_told ? 'no_backup' : 'quota';
      const found = what === 'quota' ? 'looks stopped by its quota' : 'has no backup that can start';
      if (d.dryRun) { out.push(`would say ${s.actor} ${found}`); continue; }
      // on the board first: if that fails nothing is said, and the next tick tries again; if the tell fails, the board has it
      await d.sql`select cb.supervise_log(${state.project}, ${what}, ${s.actor}, ${`herdr pane ${pane}`})`;
      const where = `herdr pane ${pane}${m ? ` on ${m}` : ''}`;
      out.push(`${s.actor} ${found} (${where})${toTell ? '' : ': no other live lead to tell; it is on the board'}`);
      if (!toTell) continue;
      if (what === 'no_backup') {
        await tell(d, toTell, `supervisor: ${s.actor} is still stopped by its model's quota and has no backup that can start, so it is left as it is (${where}). It holds ${s.holds} card(s): restart it on another model or hand them over.`, out);
        continue;
      }
      const backups = (want ? seatSpec(state.squad, want).fallback : undefined)?.map(runsOn).join(', ');
      await tell(d, toTell, `supervisor: ${s.actor} looks stopped by its model's quota: ${where} shows the CLI's limit message. It holds ${s.holds} card(s).`
        + (stop.retryAfterSec ? ` The CLI says to retry in about ${Math.ceil(stop.retryAfterSec / 60)} min.` : '')
        + (backups ? ` Backups named for the seat: ${backups}.` : '')
        + (applies && !banner ? " Automatic backup will not switch it: the words are not where the CLI prints its own limit message." : '')
        + (next ? ` If the next check still sees it, with nothing done on the board in between, the supervisor switches it to ${runsOn(next.launch)}: it is closed and started there, and keeps its cards.`
          : ' Nothing was switched or closed: check the pane, then restart it on another model or hand its cards over.'), out);
    } catch (e) {
      if (d.memory.unreadTold.has(s.actor)) continue;
      d.memory.unreadTold.add(s.actor);
      out.push(`cannot check ${s.actor} for a quota stop: ${msg(e)}`);
    }
  }
  return switches;
}
// #4332: why this machine cannot start a launch, as startOne would refuse it before any pane; null when it can
const startProblem = (l: Launch) => { try { launchSpec(l); return null; } catch (e) { return msg(e); } };
// the board keeps a short reason: the adapter's first clause (agent "codex" is not installed yet); the rest goes to the PC log
const shortWhy = (why: string) => why.split(/[:(]/)[0]!.trim().slice(0, 100);
// the live session bound to the project in the lead role, whatever its name
const leadOf = (s: State) => s.sessions.find((x) => x.role === 'lead' && x.live)?.actor;

async function act(d: Deps, state: State, plan: TickPlan, switches: Switch[], out: string[], log: Log) {
  const { run, dryRun, now, memory } = d, project = state.project;
  const tabs: Record<string, { pane: string; panes: number }> = {};
  // true: the agent started and has its first prompt
  const launch = async (what: 'restore' | 'start', l: Launch) => {
    const seen = classifyAgentGet(run(l.herdr, ['agent', 'get', herdrName(l.name)], 30_000));
    if (seen !== 'absent') { out.push(`skip ${l.name}: ${seen === 'live' ? 'running in herdr' : `could not check herdr on ${l.machine}`}`); return false; }
    const r = startOne(l, run, tabs);
    out.push(what === 'restore' ? r.line.replace(/^started /, 'restored ') : r.line);
    if (r.ok || r.pane) memory.launched.add(l.name); // the agent exists (up, on a dialog, or its prompt not sent)
    // a startup dialog, or an agent up whose first prompt was not sent: a person finishes it; the lead is told once per block.
    // Event notes carry this short kind only: herdr's own error text stays in the PC log (r.line)
    const kind = r.blocked ? 'startup dialog' : r.ok ? null : r.unconfirmed ? 'prompt not confirmed' : r.pane ? 'prompt not sent' : 'start failed';
    if (kind === 'start failed') {
      memory.failedAt.set(l.name, now);
      await log(project, 'failed', l.name, kind);
    } else if (kind) {
      await log(project, 'blocked', l.name, r.blocked ? r.pane : `${kind}, pane ${r.pane}`);
      if (!memory.blockedTold.has(l.name) && await tellLead(d, state, l, r.pane!, r.blocked ? 'dialog' : 'prompt', out)) memory.blockedTold.add(l.name);
    }
    // a restore is logged however it ended, so its 30-minute limit holds across failures and supervisor restarts
    if (!kind || what === 'restore') await log(project, what, l.name, kind ?? l.role);
    return r.ok;
  };
  // #4787 (Q3157): a seat still stopped by its quota moves to its backup: closed with its cards, which stay its own,
  // then started under its name on the backup
  for (const { n, from, launch: l, lead } of switches) {
    d.signal?.throwIfAborted();
    const to = runsOn(l);
    if (dryRun) { out.push(`would switch ${l.name} (${from} to ${to})`); continue; }
    const c = await closeOne(d, state, l.name, log, true);
    out.push(c.line);
    if (!c.gone) continue;
    // on the board before the start: from here on the seat runs its backup, and a start that fails is restored on it
    try { await d.sql`select cb.seat_switch(${project}, ${l.name}, ${n})`; }
    catch (e) { out.push(`closed ${l.name} but could not record its backup, so it was not started on it: ${msg(e)}`); continue; }
    await log(project, 'switch', l.name, `${from} to ${to}`);
    d.signal?.throwIfAborted();
    const up = await launch('start', l);
    if (lead) await tell(d, lead, `supervisor: switched ${l.name} from ${from} to ${to} after its quota stop. ${up ? 'It was started there and keeps its cards.' : 'It was closed, and its start there did not finish: see the supervisor log.'} It stays on the backup until the squad is saved or you run cb squad primary ${project} ${l.name}.`, out);
  }
  for (const [what, list] of [['restore', plan.restore], ['start', plan.start]] as const) {
    for (const l of list) {
      d.signal?.throwIfAborted();
      if (dryRun) out.push(`would ${what} ${l.name} (${l.role}, ${runsOn(l)}) on ${l.machine}`);
      else await launch(what, l);
    }
  }
  let exits = 0;
  for (const name of plan.close) {
    d.signal?.throwIfAborted();
    if (state.winding_down && exits >= WIND_DOWN_CLOSES) break;
    if (now - (memory.closeSkipAt.get(name) ?? -Infinity) < CLOSE_RETRY) continue;
    if (dryRun) { out.push(`would close ${name}`); continue; }
    const c = await closeOne(d, state, name, log);
    out.push(c.line);
    if (c.sent) exits++;
  }
  // #4332 (Q2970): a seat seen on its seat's setting again is forgotten; one on an old agent or model whose new one this
  // machine cannot start is kept, said once (restartTried)
  if (!dryRun) for (const n of plan.settled) memory.restartTried.delete(n);
  for (const r of plan.refused) {
    if (dryRun) { out.push(`would not restart ${r.session} on ${r.to}: ${r.why}`); continue; }
    memory.restartTried.set(r.session, r.to);
    out.push(`${r.session} runs an older setting than its seat, but ${r.to} cannot start here, so it keeps running: ${r.why}`);
    await log(project, 'restart', r.session, `refused, ${r.to} cannot start: ${shortWhy(r.why)}`);
  }
  // an idle seat on an old setting: closed as an idle close is, then started under its name on the seat's setting. A close
  // that did not happen (it took work, herdr lost it) is tried on a later tick; once closed, never again for this setting
  for (const { launch: l, from, to } of plan.restart) {
    d.signal?.throwIfAborted();
    if (now - (memory.closeSkipAt.get(l.name) ?? -Infinity) < CLOSE_RETRY) continue;
    if (dryRun) { out.push(`would restart ${l.name} (${from} to ${to})`); continue; }
    const c = await closeOne(d, state, l.name, log);
    out.push(c.line);
    if (!c.gone) continue;
    memory.restartTried.set(l.name, to);
    await log(project, 'restart', l.name, `${from} to ${to}`);
    d.signal?.throwIfAborted();
    await launch('start', l);
  }
  // #3770: a seat the squad file no longer generates that stays open: said once per reason, never closed or freed here
  for (const l of plan.leaving) {
    if (dryRun) out.push(`would keep ${l.session} open (left the squad file): ${LEAVING[l.why]}`);
    else if (memory.leavingTold.get(l.session) !== l.why) { memory.leavingTold.set(l.session, l.why); out.push(`${l.session} left the squad file but stays open: ${LEAVING[l.why]}`); }
  }
  if (!dryRun) for (const s of state.sessions) if (!plan.leaving.some((l) => l.session === s.actor)) memory.leavingTold.delete(s.actor);
  for (const n of plan.notes) {
    if (dryRun) out.push(`would note ${n.session} down again`);
    else { out.push(`${n.session} is down again after a restore: restore it by hand`); await log(project, 'down_again', n.session, 'restore it by hand'); }
  }
}

const LEAVING: Record<Leaving['why'], string> = {
  busy: 'it holds work or is mid-turn; closed once idle, or hand its work over',
  down: 'it is down and holds work; hand its cards over (cb edit <id> --assignee none) or restore it by hand',
  machine: "its machine is not one of the squad's machines (check the name's case); close it by hand",
  empty: 'the squad file names no seats besides the lead, so nothing is closed; fix the squad file, or close it by hand',
};

// A startup dialog (or a first prompt that was not sent) is a person's: the lead is told once per block (again only
// after that agent is gone and the name blocks anew), with the pane and the command to finish. False when no lead
// session is live or the tell failed: it is not retried (the name now runs in herdr, so it is not launched again);
// the digest's blocked line is the fallback.
async function tellLead(d: Deps, state: State, l: Launch, pane: string, why: 'dialog' | 'prompt', out: string[]) {
  const lead = leadOf(state);
  if (!lead) { out.push(`${state.project}: no live lead to tell about ${l.name}`); return false; }
  const where = `herdr pane ${pane}${l.herdr ? ` on ${l.herdr}` : ''}`;
  // a prompt that lists repo folders (architect, qa in a project of several repos) carries absolute paths, which board
  // text never does: the lead is pointed at the PC log, where startOne's line already printed the full command
  const local = l.prompt.includes('. Repos: ');
  const text = why === 'dialog'
    ? `supervisor: ${l.name} waits on a startup dialog in ${where}. Answer it there, then run${local ? ' the prompt command the supervisor printed in the PC log.' : `: ${promptCommand(l)}`}`
    // PR 117 S2: a prompt herdr refused and one that may have landed read the same: the lead looks before sending
    : `supervisor: ${l.name} started in ${where} but its first prompt may not have landed: check the pane, then send it if it is not there${local ? ' with the prompt command the supervisor printed in the PC log.' : `: ${promptCommand(l)}`}`;
  return tell(d, lead, text, out);
}

async function tell(d: Deps, to: string, text: string, out: string[]) {
  try { await d.sql`select cb.tell(${to}, ${text}, 'supervisor')`; return true; } catch (e) { out.push(`could not tell ${to}: ${msg(e)}`); return false; }
}

// Mark closing, find its pane, re-check on a fresh statement, /exit (its agent adapter's close), wait for herdr to drop
// the agent, close its pane. gone: the agent left herdr (#4332: only then does a restart start it again)
async function closeOne(d: Deps, state: State, name: string, log: Log, switching = false): Promise<{ line: string; gone?: true; sent?: true }> {
  const { sql, run } = d, sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))), clock = d.clock ?? Date.now;
  const unmark = () => sql`select cb.supervise_mark(${name}, false)`.catch(() => {});
  const windDown = !!state.winding_down;
  if (!(await sql`select cb.supervise_mark(${name}, true) as ok`)[0].ok) {
    if (windDown) d.memory.closeSkipAt.set(name, d.now); // it holds a live project's card: not asked again every tick
    return { line: `skip closing ${name}: it holds work or has no session` };
  }
  const m = state.squad.machines[name.split('@')[1]!]?.herdr ?? null, hn = herdrName(name);
  let pane: string | undefined, status: string | undefined, s: Session | undefined;
  try { // a throw before /exit is sent (the re-check, herdr) clears the mark too
    try { const got = herdrJson(run, m, ['agent', 'get', hn], 30_000); pane = find(got, 'pane_id'); status = find(got, 'agent_status'); } catch {}
    if (!pane) { await unmark(); d.memory.closeSkipAt.set(name, d.now); return { line: `could not close ${name}: herdr does not show it` }; }
    // the re-check sits right before /exit: the agent get above can take 30 s, long enough for a claim or an ask to land
    const fresh = (await sql`select cb.supervise_state(${state.project}) as s`)[0].s as State;
    s = fresh.sessions.find((x) => x.actor === name);
    if (windDown) { // #4559: it may keep cards, but only while the project still gets no work and it is still quiet
      if (!fresh.winding_down) { await unmark(); return { line: `skip closing ${name}: ${state.project} is enabled again` }; }
      if (!s || s.jobs_running || (s.bound && s.bound !== fresh.project) || !windDownQuiet(s, fresh.state_at, d.now)) { await unmark(); return { line: `skip closing ${name}: it is working again` }; }
    } else if (switching) { // #4787: it keeps its cards, but only while the switch is on and the same stop still stands
      if (!s || !fresh.supervised || !fresh.auto_backup || !s.quota_told) { await unmark(); return { line: `skip closing ${name}: it acted since its quota stop, or automatic backup is off` }; }
    } else if (!s || s.holds || s.questions || s.jobs || s.asks) { await unmark(); return { line: `skip closing ${name}: it took work` }; }
    // the agent running there now judges and closes it (#4002); one with no adapter yet is never closed
    let adapter: AgentAdapter;
    try { adapter = getAdapter(s.agent ?? 'claude'); } catch (e) { await unmark(); return { line: `skip closing ${name}: ${msg(e)}` }; }
    const seat = seatOf(state, name, adapter.kind, pane, s.machine);
    if (status !== undefined && !(await adapter.readStatus(seat, { agent_status: status })).safeToClose) { await unmark(); return { line: `skip closing ${name}: herdr shows it ${status}` }; }
    d.signal?.throwIfAborted(); // last moment before /exit: an abandoned tick sends none
    if (await adapter.close(seat, run) !== 'sent') { await unmark(); return { line: `could not close ${name}: /exit was not sent` }; }
  } catch (e) { await unmark(); throw e; }
  for (const until = clock() + CLOSE_WAIT; clock() < until;) { // wall time: one agent get can take 30 s
    await sleep(POLL);
    d.signal?.throwIfAborted();
    if (classifyAgentGet(run(m, ['agent', 'get', hn], 30_000)) !== 'absent') continue;
    const closed = run(m, ['pane', 'close', pane], 30_000).status === 0;
    await log(state.project, 'close', name, windDown ? 'project disabled' : switching ? 'quota switch' : s!.role); // the mark stays until it lapses; cb.iam clears it if the name binds again
    return { line: closed ? `closed ${name}` : `closed ${name}; its pane ${pane} did not close`, gone: true, sent: true };
  }
  // /exit was sent and it may still be exiting: the mark stays and lapses in 5 minutes, so no card lands on it meanwhile
  return { line: `could not close ${name}`, sent: true };
}

// The PC runner: no beat for 3 minutes → start it in a herdr tab, at most once per 10 minutes, unless its log port is
// still held. A start that does not beat, or a held port, is told to every supervised project's lead, hourly.
async function runnerCheck(d: Deps, out: string[], log: Log, leads: string[]) {
  if (!d.runnerConfig) return;
  // #3902: validated with the recipes.ts this supervisor started with. A newer runner.json it refuses (a raised cap, a
  // new key) must not stop it restarting a dead runner: the name and log port are enough here, and the runner, started
  // fresh, checks the whole file with current code. Only a file with no usable name/port stops it.
  let cfg: { name?: string; log: { host: string; port: number } };
  try { cfg = loadConfig(readFileSync(d.runnerConfig, 'utf8')); } catch (e) {
    let raw: any;
    try { raw = JSON.parse(readFileSync(d.runnerConfig, 'utf8')); } catch {}
    if (!raw || typeof raw?.log?.host !== 'string' || !Number.isInteger(raw?.log?.port)) { out.push(`runner config: ${msg(e)}`); return; }
    out.push(`runner config: ${msg(e)} (by this supervisor's code; the runner checks it again with current code)`);
    cfg = { name: typeof raw.name === 'string' ? raw.name : undefined, log: { host: raw.log.host, port: raw.log.port } };
  }
  const name = cfg.name ?? machine();
  const { runners } = (await d.sql`select cb.jobs_list(null) as j`)[0].j;
  const beat = runners.find((r: any) => r.name === name)?.last_seen;
  if (beat && d.now - Date.parse(beat) < RUNNER_STALE) return;
  const tellLeads = async (text: string) => {
    if (d.dryRun || d.now - d.memory.runnerToldAt < HOUR) return false;
    d.memory.runnerToldAt = d.now;
    for (const to of leads) await tell(d, to, `supervisor: ${text}`, out);
    return true;
  };
  const since = d.now - d.memory.runnerStartedAt;
  if (since < RUNNER_RETRY) {
    const text = `runner started ${Math.round(since / 60_000)} min ago and still not beating`;
    out.push(text);
    await tellLeads(`${text}: see the herdr tab runner on the PC`);
    return;
  }
  if (await d.probe(cfg.log.host, cfg.log.port)) {
    const text = `runner ${name} is not beating but its port is held`;
    if (d.dryRun) { out.push(text); return; }
    if (await tellLeads(`${text}: an old runner may be stuck; restart it by hand`)) { out.push(text); await log(null, 'runner', name, 'not beating but its port is held'); }
    return;
  }
  if (d.dryRun) { out.push('would start the runner'); return; }
  d.memory.runnerStartedAt = d.now;
  // the runner tab this run opened before is dead (no beat, port free): close that pane only, if it still exists.
  // herdr never reuses a closed pane id; the terminal id also guards against a herdr restart
  const old = d.memory.runnerPane;
  d.memory.runnerPane = undefined;
  if (old) try {
    const t = find(herdrJson(d.run, null, ['pane', 'get', old.pane], 30_000), 'terminal_id');
    if (!old.terminal || t === old.terminal) herdrJson(d.run, null, ['pane', 'close', old.pane], 30_000);
  } catch {} // gone already
  try {
    const created = herdrJson(d.run, null, ['tab', 'create', '--cwd', BOARD, '--label', 'runner', '--no-focus']);
    const pane = find(created, 'pane_id');
    if (!pane) throw new Error('herdr returned no pane id');
    d.memory.runnerPane = { pane, terminal: find(created, 'terminal_id') };
    herdrJson(d.run, null, ['pane', 'run', pane, 'cb runner']);
    out.push(`started the runner in herdr pane ${pane}`);
    await log(null, 'runner', name, 'started');
  } catch (e) { out.push(`could not start the runner: ${msg(e)}`); }
}

const probe = (host: string, port: number) => new Promise<boolean>((ok) => {
  const s = net.connect({ host, port, timeout: 3_000 });
  s.once('connect', () => { s.destroy(); ok(true); });
  s.once('timeout', () => { s.destroy(); ok(false); });
  s.once('error', () => ok(false));
});

// One supervisor anywhere: a session advisory lock on its own one-connection client that is never recycled. A dropped
// connection (board restart, killed backend) takes the lock with it; postgres.js reconnects a pool connection on its
// next query, so the next check takes the lock again there (a reserved connection it never reconnects: a query on it
// throws from a timer and never settles). True: held; false: another supervisor took it; throws: board unreachable.
export const lockClient = (app: string) => connect(undefined, { app, max: 1, lifetime: null });
export const locked = async (lock: any) => (await lock`select pg_try_advisory_lock(hashtext('cb-supervisor')) as ok`)[0]!.ok === true;

if (import.meta.main) {
  const dryRun = process.argv.includes('--dry-run'), once = process.argv.includes('--once');
  const version = createHash('sha256').update(['supervise.ts', 'supervise-plan.ts', 'squad-up.ts', 'agents/index.ts', 'agents/screen.ts', 'agents/claude.ts', 'agents/codex.ts', 'agents/agy.ts', 'agents/opencode.ts']
    .map((f) => readFileSync(join(import.meta.dirname, f), 'utf8')).join('\0')).digest('hex').slice(0, 7);
  const app = `cb-supervisor/${version}`;
  let sql = connect(undefined, { app, max: 1 });
  // A dry run writes nothing, so it takes no lock (it may preview while a supervisor runs). Checked every tick, before
  // anything acts: re-entrant (true); board unreachable: the tick fails and the next one tries again
  let lock = dryRun ? null : lockClient(app);
  const isLocked = async () => !lock || await withDeadline(locked(lock), 30_000, 'the supervisor lock check');
  // review I3: a board down at start is a failed first tick (retried every 60 s), not a crash with a stack trace
  try { if (!(await isLocked())) { console.log('another supervisor is running'); process.exit(1); } }
  catch (e) { console.log(`${new Date().toISOString()} board unreachable at start (${msg(e)}): trying again every 60 s`); }
  const home = process.env.CB_SUPERVISOR_HOME || join(homedir(), '.claude-board', 'supervisor');
  const say = (line: string) => {
    const at = new Date().toISOString();
    console.log(`${at} ${line}`);
    if (!dryRun) try { appendFileSync(join(home, `${at.slice(0, 10)}.log`), `${at} ${line}\n`); } catch {}
  };
  if (!dryRun) {
    mkdirSync(home, { recursive: true });
    for (const f of readdirSync(home)) try { if (statSync(join(home, f)).mtimeMs < Date.now() - 7 * 86_400_000) rmSync(join(home, f)); } catch {}
    say(`supervisor up (cb-supervisor/${version})`);
  }
  const configPath = process.env.CB_RUNNER_CONFIG || join(homedir(), '.claude-board', 'runner.json');
  const memory: Memory = { failedAt: new Map(), blockedTold: new Set(), launched: new Set(), runnerToldAt: 0, runnerStartedAt: 0,
    closeSkipAt: new Map(), elsewhereToldAt: new Map(), leavingTold: new Map(), restartTried: new Map(), unreadTold: new Set() };
  let code = 0;
  for (;;) {
    try {
      if (!(await isLocked())) { say('another supervisor is running'); process.exit(1); }
      const now = ((await withDeadline(sql`select now() as t`, 30_000, 'the board clock'))[0]!.t as Date).getTime(); // the board's clock: planTick compares DB times
      const runnerConfig = existsSync(configPath) ? configPath : null;
      // the whole tick's cap is far above its worst case (3 starts at up to 180 s of herdr each, closes at 60 s each):
      // it catches a hang, not a slow tick; the DB waits above have their own 30 s. A tick given up on is aborted, so
      // it stops at its next step instead of acting on with its log writes failing (review I1, I2)
      const stop = new AbortController();
      try {
        for (const line of await withDeadline(tick({ sql, run: realRun, dryRun, now, memory, runnerConfig, probe, signal: stop.signal }), TICK_MS, 'the tick')) say(line);
      } finally { stop.abort(); }
      code = 0;
    } catch (e) {
      say(`tick failed: ${msg(e)}`); code = 1;
      // #4261: a hung query means a dead connection that may never error: drop both clients and start fresh (the lock
      // goes with its connection; the next check takes it again, or finds another supervisor and exits)
      if (e instanceof DeadlineError) {
        say('reconnecting to the board: fresh clients');
        const old = [sql, lock];
        sql = connect(undefined, { app, max: 1 });
        if (lock) lock = lockClient(app);
        for (const c of old) c?.end({ timeout: 0 }).catch(() => {});
      }
    }
    if (dryRun || once) break;
    await new Promise((r) => setTimeout(r, 60_000));
  }
  process.exit(code);
}
