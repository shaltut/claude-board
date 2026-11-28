// The supervisor's pure planner: from the board's facts and herdr's, decide this tick's restores, starts, closes and notes.
import { herdrName, launchFor, runsOn, seatSpec, wantList, type Launch, type Squad } from './squad-up.ts';

export type Session = { actor: string; role: string; area: string | null; repo: string; machine: string | null; pane: string | null; live: boolean;
  holds: number; questions: number; jobs: number; asks: number; last_event: string | null; closing: boolean; last_restore: string | null;
  jobs_running?: number; // of jobs, those running now (#4559); absent (an older board): none
  bound?: string | null; // the project its latest session is bound to (#4559); null or absent: not known
  last_restore_failed: boolean; down_again_logged: boolean; down_again_since_bind: boolean;
  agent?: string | null; // the agent the session runs (#4002); null or absent (a holder with no session row): claude
  quota_told?: boolean; // #4787: its quota stop is already on the board, and it has done nothing there since
  model?: string | null }; // the model it bound with (cb iam --model, #4332); null or absent: unknown, never judged
export type State = { project: string; squad: Squad; supervised: boolean;
  // #4806: false: no stages, so no waiting work is counted; absent (an older board): stages. supervised_unstaged: a
  // squad the supervisor runs there (the tick reads it into supervised)
  pipeline?: boolean; supervised_unstaged?: boolean;
  // #4559 slice 3: a supervised squad's project that gets no work (disabled, archived), and since when
  winding_down?: boolean; state_at?: string | null;
  state?: string; // the project's own: enabled, disabled or archived; absent (an older board): enabled
  // builder and reviewer: per repo (#3703); owner: per area
  waiting: { builder: Record<string, number>; reviewer: Record<string, number>; qa: number; investigator: number; architect: number; owner: Record<string, number> };
  // #4593 review 100 F1: of the waiting cards, those kept for an agent (for: labels), by the agents named ("codex",
  // "agy,codex"); shaped as waiting. Absent (an older board): none kept
  kept?: { builder?: Record<string, Kept>; reviewer?: Record<string, Kept>; qa?: Kept; investigator?: Kept; architect?: Kept; owner?: Record<string, Kept> };
  sessions: Session[] };
export type Kept = Record<string, number>;
// launched: names this supervisor run started or restored that the board has not yet seen live
// herdrStatus: herdr's agent_status per herdr name (idle, working, blocked, done, unknown); only READY may be closed
// safeToClose (#4002): per session (actor), its agent adapter's answer, which then decides instead of herdrStatus; a
// session it does not name is not closed. Omitted: herdrStatus and READY, as before
// pastSeats (#3770): non-lead names an earlier saved version of this squad generated (pastSeatNames); omitted: none
// restartTried (#4332): per seat, the setting (runsOn words) this run already restarted it for or refused: never again
// for the same setting, so a seat that comes back still reading as old, or a setting that cannot start, makes no loop
// startProblem (#4332): why this machine cannot start a launch (its agent not installed, a model its adapter refuses),
// null when it can; omitted: none
export type TickInput = { state: State; herdrLive: Set<string>; herdrStatus: Record<string, string>; herdrDown: Set<string>; launched: Set<string>; macLive: number; startsLeft: number; failedAt: Map<string, number>; now: number;
  safeToClose?: Record<string, boolean>; pastSeats?: Set<string>; restartTried?: Map<string, string>; startProblem?: (l: Launch) => string | null };
// leaving (#3770): seats the squad file no longer generates that stay open for now: busy (live with work), down holding
// work, on a machine that is not one of the squad's, or every seat while the squad names none besides the lead (empty).
// The supervisor never closes or frees these: a person hands over.
export type Leaving = { session: string; why: 'busy' | 'down' | 'machine' | 'empty' };
// restart (#4332, Q2970): an idle seat on an old agent or model, closed then started on its seat's setting (launch).
// from/to: what it runs and what the squad names, in runsOn words. refused: a seat on an old setting whose new one this
// machine cannot start (why): kept as it is, said once. settled: seats restartTried names that now run their seat's
// setting (bound again on it, by the restart or by hand): forgotten, so a later change back to that setting is acted on
export type Restart = { launch: Launch; from: string; to: string };
export type Refused = { session: string; to: string; why: string };
export type TickPlan = { restore: Launch[]; start: Launch[]; close: string[]; notes: { what: 'down_again'; session: string }[]; leaving: Leaving[];
  restart: Restart[]; refused: Refused[]; settled: string[] };

/** #4559 (Q3018): how long a seat of a project that gets no work is quiet before it is closed. */
export const WIND_DOWN_AFTER = 10 * 60_000;
/** Whether a seat has been quiet that long, counted from the project's state change at the earliest: every seat has
 *  that long after a disable to reach a safe point. */
export const windDownQuiet = (s: Pick<Session, 'last_event'>, stateAt: string | null | undefined, now: number) =>
  !!s.last_event && now - Math.max(Date.parse(s.last_event), stateAt ? Date.parse(stateAt) : 0) >= WIND_DOWN_AFTER;

/** herdr agent_status values that mean ready for input; an unfocused pane stays `done` after its turn, never `idle`. */
export const READY = new Set(['idle', 'done']);
const MIN = 60_000, CLOSE_AFTER = 20 * MIN, RETRY_AFTER = 10 * MIN, RESTORE_EVERY = 30 * MIN, MAC = 'macbook', MAC_CAP = 8;
const LEAVING_CLOSES = 2; // a bad squad save cannot drain a squad in one tick
// #4332: a seat restarts on a changed setting only once it has been quiet 5 minutes: past the moment a seat that just
// passed a card runs cb next and claims the next one, or a fresh one binds (last_event counts from its bind), yet well
// under the 20-minute idle close, so the change lands soon. At most 2 a tick, as leaving closes: one squad save cannot
// recycle a whole squad at once, and each restart takes a start from the tick's shared budget
const RESTART_AFTER = 5 * MIN, RESTARTS = 2;

/** Whether a session runs another setting than its seat's (#4332): another agent, or a model it named that does not
 *  contain the seat's (case-insensitive, as the digest's wrong-model line reads it: claude-opus-4-5 runs opus). */
export function onOldSetting(s: Pick<Session, 'agent' | 'model'>, want: { agent: string; model: string }): boolean {
  if ((s.agent ?? 'claude') !== want.agent) return true;
  return !!s.model && !s.model.toLowerCase().includes(want.model.toLowerCase());
}

/** The non-lead names any of these saved squad versions generated (#3770); a version wantList cannot read is skipped. */
export function pastSeatNames(project: string, squads: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const sq of squads) {
    try { for (const w of wantList(project, sq as Squad)) if (w.role !== 'lead') names.add(w.name); } catch {}
  }
  return names;
}
/** Whether a tick needs pastSeats: a live or holding non-lead session the squad does not want now. */
export function mayBeLeaving(state: State, herdrLive: Set<string>): boolean {
  const now = new Set(wantList(state.project, state.squad).map((w) => w.name));
  return state.sessions.some((s) => s.role !== 'lead' && !now.has(s.actor) && (s.live || s.holds > 0 || herdrLive.has(herdrName(s.actor))));
}

/** #4787: whether a project's seats are checked for a quota stop: it gets work. Its pipeline and supervise switches do
 *  not matter, since the check only reads screens and tells. */
export const quotaWatched = (state: Pick<State, 'state'>) => (state.state ?? 'enabled') === 'enabled';

/** #4787: the seats whose screen is read for a quota stop: this squad's seats and the lead, bound to this project, that
 *  herdr runs and does not show working (a quota stop ends the turn; a working seat's screen holds its own output). */
export function quotaChecks(state: State, herdrStatus: Record<string, string>, herdrDown: Set<string>): Session[] {
  if (!quotaWatched(state)) return [];
  const mine = new Set(wantList(state.project, state.squad).map((w) => w.name));
  return state.sessions.filter((s) => {
    const status = herdrStatus[herdrName(s.actor)] ?? '';
    return (mine.has(s.actor) || s.role === 'lead') && (!s.bound || s.bound === state.project) && !s.closing
      && !herdrDown.has(s.actor.split('@')[1]!) && (READY.has(status) || status === 'blocked');
  });
}

export function planTick(i: TickInput): TickPlan {
  const { state, herdrLive, herdrDown, now } = i;
  const plan: TickPlan = { restore: [], start: [], close: [], notes: [], leaving: [], restart: [], refused: [], settled: [] };
  if (!state.supervised && !state.winding_down) return plan;
  const { squad, project } = state;
  const by = new Map(state.sessions.map((s) => [s.actor, s]));
  const machineOf = (n: string) => n.split('@')[1];
  const isMac = (n: string) => machineOf(n) === MAC || squad.machines[machineOf(n)]?.herdr === MAC;
  const isLive = (n: string) => !!by.get(n)?.live || herdrLive.has(herdrName(n));
  const failed = (n: string) => now - (i.failedAt.get(n) ?? -Infinity) < RETRY_AFTER;
  const ok = (n: string) => !herdrDown.has(machineOf(n)) && !failed(n);
  const safe = (n: string) => (i.safeToClose ? i.safeToClose[n] === true : READY.has(i.herdrStatus[herdrName(n)] ?? ''));
  let startsLeft = i.startsLeft, macRoom = MAC_CAP - i.macLive;
  const take = (n: string) => { startsLeft--; if (isMac(n)) macRoom--; };
  const room = (n: string) => startsLeft > 0 && (!isMac(n) || macRoom > 0);
  const wanted = wantList(project, squad).filter((w) => w.role !== 'lead');
  // #4559 slice 3 (Q3018): a project that gets no work only closes. Its squad's seats (this version's and earlier
  // ones'), never the lead, whom nothing would start again, or a hand-started session. A seat is closed once herdr shows
  // it ready and it has been quiet 10 minutes, with the cards it holds (Q3017); its own running job waits for its end,
  // while a queued one cannot start until the project is enabled. All that qualify are planned: the supervisor stops
  // after WIND_DOWN_CLOSES that reached /exit, so one the board refuses takes no place from the others
  if (state.winding_down) {
    const mine = new Set(wanted.map((w) => w.name));
    for (const s of state.sessions) {
      if (s.role === 'lead' || !(mine.has(s.actor) || i.pastSeats?.has(s.actor))) continue;
      if (s.bound && s.bound !== project) continue; // it moved to another project and only holds a card here
      if (isLive(s.actor) && !s.closing && !s.jobs_running && !herdrDown.has(machineOf(s.actor)) && safe(s.actor)
        && windDownQuiet(s, state.state_at, now)) plan.close.push(s.actor);
    }
    return plan;
  }
  const restored = new Set<string>();
  const idle = (s: Session) => s.live && !s.holds && !s.questions && !s.jobs && !s.asks && !s.closing;
  // #3770: a name an earlier version of this squad generated but this one does not (its role moved machine, its count
  // went down, its role or repo left) is leaving: it counts toward no role's slots, cancels no waiting work, and is closed
  // once idle whatever waits (the work is the new seats'), at most 2 a tick. Busy, or down holding work, it stays and is
  // listed. A hand-started name no squad version generated is never leaving; a dead row holding nothing: ignored
  const wantedNames = new Set(wanted.map((w) => w.name));
  const leaving = new Set(state.sessions.filter((s) => s.role !== 'lead' && !wantedNames.has(s.actor) && !!i.pastSeats?.has(s.actor)
    && (isLive(s.actor) || s.holds > 0)).map((s) => s.actor));

  for (const w of wanted) {
    const s = by.get(w.name);
    if (!s || !s.holds || isLive(w.name) || herdrDown.has(machineOf(w.name))) continue;
    if (s.down_again_since_bind) continue; // down again after a restore: a person restores it; no loop until it binds again
    const since = s.last_restore ? now - Date.parse(s.last_restore) : Infinity;
    if (s.last_restore_failed) { if (since < RETRY_AFTER) continue; } // it never started: tried again after 10 minutes
    else if (since < RESTORE_EVERY) {
      if (!s.down_again_logged) plan.notes.push({ what: 'down_again', session: w.name });
      continue;
    }
    if (!ok(w.name) || !room(w.name)) continue;
    plan.restore.push(launchFor(project, squad, w, 'resume'));
    restored.add(w.name);
    take(w.name);
  }

  // one want group per role (owners: one per area; builders and reviewers: one per repo)
  const perRepo = (role: string): role is 'builder' | 'reviewer' => role === 'builder' || role === 'reviewer';
  const groups = new Map<string, { role: string; area?: string; repo: string; waiting: number; kept: Kept; names: typeof wanted }>();
  for (const w of wanted) {
    const key = `${w.role}/${w.area ?? ''}/${w.repo}`;
    const waiting = w.role === 'owner' ? state.waiting.owner[w.area!] ?? 0
      : perRepo(w.role) ? state.waiting[w.role][w.repo] ?? 0
      : state.waiting[w.role as 'qa' | 'investigator' | 'architect'] ?? 0;
    const k = state.kept, kept = (w.role === 'owner' ? k?.owner?.[w.area!] : perRepo(w.role) ? k?.[w.role]?.[w.repo]
      : k?.[w.role as 'qa' | 'investigator' | 'architect']) ?? {};
    (groups.get(key) ?? groups.set(key, { role: w.role, area: w.area, repo: w.repo, waiting, kept, names: [] }).get(key)!).names.push(w);
  }
  // #4593 review 100 F1: kept work counts only for seats of an agent it names ("agy,codex": either)
  const fits = (agent: string, k: string) => k.split(',').includes(agent);
  const wantAgent = (w: (typeof wanted)[number]) => seatSpec(squad, w).agent;
  for (const g of groups.values()) {
    const mine = state.sessions.filter((s) => !leaving.has(s.actor) && s.role === g.role && (g.area === undefined || s.area === g.area) && (!perRepo(g.role) || s.repo === g.repo));
    // a name this run launched that herdr runs but the board does not see yet (still starting, or on a startup
    // dialog) counts as started: live, and about to take work, so the next tick does not start another for the same
    // card. Only this run's launches: any other herdr-only name would cancel waiting work for as long as its pane lives.
    const pending = g.names.filter((w) => i.launched.has(w.name) && herdrLive.has(herdrName(w.name)) && !by.get(w.name)?.live && !by.get(w.name)?.holds);
    const liveCount = mine.filter((s) => (s.live || herdrLive.has(herdrName(s.actor))) && !s.closing).length
      + pending.filter((w) => !mine.some((s) => s.actor === w.name)).length + g.names.filter((w) => restored.has(w.name)).length;
    // what waits: kept work by the agents it names, the rest for anyone. Each idle or pending seat takes a kept card it
    // fits first, else one for anyone; what is left is started for, kept work by a seat of its agent first
    const left: Kept = Object.fromEntries(Object.entries(g.kept).filter(([, n]) => n > 0));
    let anyLeft = Math.max(0, g.waiting - Object.values(left).reduce((a, b) => a + b, 0));
    const anyWait = anyLeft > 0, keptWait = { ...left };
    const cover = (agent: string) => {
      const k = Object.keys(left).find((x) => fits(agent, x) && left[x]! > 0);
      if (k) left[k]!--; else if (anyLeft > 0) anyLeft--;
    };
    for (const s of mine.filter(idle)) cover(s.agent ?? 'claude');
    for (const w of pending) cover(wantAgent(w));
    let n = g.names.length - liveCount;
    const startable = (w: (typeof wanted)[number]) => !isLive(w.name) && !restored.has(w.name) && !by.get(w.name)?.holds && ok(w.name) && room(w.name)
      && !plan.start.some((l) => l.name === w.name);
    const start = (w: (typeof wanted)[number]) => { plan.start.push(launchFor(project, squad, w)); take(w.name); n--; };
    for (const k of Object.keys(left)) for (const w of g.names) {
      if (n <= 0 || left[k]! <= 0) break;
      if (fits(wantAgent(w), k) && startable(w)) { start(w); left[k]!--; }
    }
    for (const w of g.names) {
      if (n <= 0 || anyLeft <= 0) break;
      if (startable(w)) { start(w); anyLeft--; }
    }
    // #4806: with no stages the board cannot say what waits for a seat, and nothing would start it again: it stays open
    if (state.pipeline === false) continue;
    // a seat stays open while work it could take waits; kept work for another agent does not keep it
    const wanted4 = (agent: string) => anyWait || Object.keys(keptWait).some((k) => fits(agent, k));
    for (const w of g.names) {
      const s = by.get(w.name);
      if (s && !wanted4(s.agent ?? 'claude') && !herdrDown.has(machineOf(w.name)) && idle(s) && safe(w.name)
        && s.last_event && now - Date.parse(s.last_event) >= CLOSE_AFTER) plan.close.push(w.name);
    }
  }
  let closesLeft = LEAVING_CLOSES;
  for (const n of leaving) {
    const s = by.get(n)!;
    if (!wanted.length) plan.leaving.push({ session: n, why: 'empty' }); // a squad with no seats besides the lead: likely a bad save
    else if (!Object.hasOwn(squad.machines, machineOf(n))) plan.leaving.push({ session: n, why: 'machine' }); // its herdr is unknown
    else if (!isLive(n)) plan.leaving.push({ session: n, why: 'down' });
    else if (!idle(s)) { if (!s.closing) plan.leaving.push({ session: n, why: 'busy' }); } // closing: a close is under way
    else if (closesLeft > 0 && !herdrDown.has(machineOf(n)) && safe(n) && s.last_event && now - Date.parse(s.last_event) >= CLOSE_AFTER) { plan.close.push(n); closesLeft--; }
  }
  // #4332 (Q2970): a squad seat running another agent or model than its seat names now is closed and started on the new
  // one, once idle (holding nothing, ready in herdr) and quiet 5 minutes; busy, it waits. Squad seats only: never the
  // lead (the supervisor never starts one), a hand-started name or a leaving seat. After restores and starts, so waiting
  // work comes first; a seat this tick closes anyway gets the new setting at its next start. A setting this machine
  // cannot start is refused (said at once, busy or not), and a seat already restarted or refused for this setting is
  // left alone (restartTried) until it is seen on its seat's setting (settled)
  let restartsLeft = RESTARTS;
  const closing = new Set(plan.close);
  for (const w of wanted) {
    const s = by.get(w.name);
    if (!s?.live) continue;
    const spec = seatSpec(squad, w), to = runsOn(spec);
    if (!onOldSetting(s, spec)) { if (i.restartTried?.has(w.name)) plan.settled.push(w.name); continue; }
    if (closing.has(w.name) || i.restartTried?.get(w.name) === to) continue;
    const l = launchFor(project, squad, w), why = i.startProblem?.(l) ?? null;
    if (why) { plan.refused.push({ session: w.name, to, why }); continue; }
    if (restartsLeft <= 0 || startsLeft <= 0 || !idle(s) || !safe(w.name) || !ok(w.name) || i.launched.has(w.name)
      || !s.last_event || now - Date.parse(s.last_event) < RESTART_AFTER) continue;
    const agent = s.agent ?? 'claude';
    plan.restart.push({ launch: l, from: s.model ? runsOn({ agent, model: s.model }) : agent, to });
    restartsLeft--; startsLeft--; // its close frees its own machine slot: no Mac room taken
  }
  return plan;
}
