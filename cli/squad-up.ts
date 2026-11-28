// cb squad up: start a project's missing squad sessions through herdr. planSquad is pure (tested);
// squadUp is the thin herdr runner (proved by the live check, not unit tests).
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { getAdapter, isAgentKind, mcpGateOk, type AgentKind } from './agents/index.ts';
import type { AgentAdapter, LaunchSpec } from './agents/types.ts';
import { homeTrust, type TrustCheck } from './squad-trust.ts';

// machine.repo: the one repo's folder of a squad without repos; with repos each repo lists its own paths (#3703)
// machine.workspace: the herdr workspace (its label) new sessions open in; none: herdr's focused one (#3719)
type Machine = { herdr: string | null; repo?: string; board: string; workspace?: string };
// #4002: a role's agent (absent: claude, never stored), its ranked fallback, and per-seat overrides of either; #4763: an
// effort on each (absent: the agent's own default). A seat's
// key is Want.seatKey. The supervisor moves a quota-stopped seat down its fallback where automatic backup is on (#4787).
type Fallback = { agent: AgentKind; model: string; effort?: string }[];
export type SeatOverride = { agent?: AgentKind; model?: string; effort?: string; fallback?: Fallback };
type Role = { count?: number | Record<string, number>; model: string; machine: string; agent?: AgentKind; effort?: string; fallback?: Fallback; seats?: Record<string, SeatOverride> };
type Repo = { home: boolean; paths: Record<string, string> };
// protected (#3746): branch names or * globs; each session's pane gets CB_PROTECTED_BRANCHES, read by the push hook
export type Squad = { machines: Record<string, Machine>; roles: Record<string, Role>; repos?: Record<string, Repo>;
  areas: (string | { name: string; repo: string })[]; supervise?: boolean; protected?: string[] };
// seatKey: the lead 1, an owner its area, builders and reviewers <repo>:<n> in a squad with repos, else the number
// (as cb.squad_set saves seats and cb._expected_model reads them)
export type Want = { name: string; role: string; area?: string; repo: string; seatKey: string };
// env: set in the session's pane (herdr --env), so the agent and its hooks inherit it: always CB_ROLE and CB_AGENT,
// CB_MCP_GATE_OK for another agent than claude when it is set where the launch is planned (gateEnv), and
// CB_PROTECTED_BRANCHES when the squad has a list. board: the board checkout on the machine (the adapter's kit path)
export type Launch = { name: string; role: string; area?: string; repo: string; seatKey: string; agent: AgentKind; model: string; effort?: string; fallback?: Fallback;
  machine: string; herdr: string | null; board: string; cwd: string; settings: string; prompt: string; workspace?: string; env: Record<string, string> };

const LETTER: Record<string, string> = { architect: 'A', builder: 'B', reviewer: 'R', qa: 'Q', investigator: 'I' };
const ORDER = ['lead', 'architect', 'owner', 'builder', 'reviewer', 'qa', 'investigator'];
const MAC = 'macbook', MAC_CAP = 8;

type Live = { actor: string; machine: string; project?: string | null; role?: string | null };
// a session not live now, as sessions_overview gives it: its actor's latest session, last_seen as an ISO time
type Seen = { actor: string; project?: string | null; role?: string | null; last_seen?: string | null };
export type QuietLead = { actor: string; mins: number };

// A session's role as cb._role reads it: unset, an orch name is the lead
const roleOf = (l: { actor: string; role?: string | null }) => l.role ?? (l.actor === 'orch' || l.actor.startsWith('orch@') ? 'lead' : null);
const DAY_MS = 24 * 3600_000; // cb.triagers' window: a lead seen within it still leads

/** The squad's wanted sessions with the lead settled against who is live (#3746). A project's lead is the session live in
 *  it with the lead role, whatever its name: then no lead is wanted, unless it goes by one of the squad's lead names (kept,
 *  so it is skipped as live). A lead-role session of the project seen in the last day but not live is still its lead: no
 *  second lead is started beside it (quietLead names it), unless it goes by a squad lead name, restarted as before.
 *  orch@<m> live, or seen in the last day, in another project leads that one: this project's is <project>-orch@<m>.
 *  The return type is spelled out: quietLead is set inside the flatMap callback, which TS's narrowing cannot see. */
function wantNow(project: string, squad: Squad, live: Live[], quiet: Seen[] = [], now = Date.now()): { want: Want[]; quietLead: QuietLead | null } {
  let quietLead: QuietLead | null = null;
  const want = wantList(project, squad).flatMap((w): Want[] => {
    if (w.role !== 'lead') return [w];
    const here = live.filter((x) => x.project === project), alt = { ...w, name: `${project}-${w.name}` };
    for (const c of [w, alt]) if (here.some((x) => x.actor === c.name)) return [c];
    if (here.some((x) => roleOf(x) === 'lead')) return [];
    const q = quiet.map((x) => ({ actor: x.actor, project: x.project, role: x.role, at: Date.parse(x.last_seen ?? '') }))
      .filter((x) => x.project === project && roleOf(x) === 'lead' && now - x.at < DAY_MS) // no last_seen: NaN, never in
      .sort((a, b) => b.at - a.at)[0];
    if (q) {
      for (const c of [w, alt]) if (q.actor === c.name) return [c];
      quietLead = { actor: q.actor, mins: Math.max(0, Math.floor((now - q.at) / 60_000)) }; // #3779: the board's clock may run ahead
      return [];
    }
    // orch@<m> live, or seen in the last day, bound to another project leads that one: taking its name here would rebind it
    const elsewhere = (x: { actor: string; project?: string | null }) => x.actor === w.name && !!x.project && x.project !== project;
    return [live.some(elsewhere) || quiet.some((x) => elsewhere(x) && now - Date.parse(x.last_seen ?? '') < DAY_MS) ? alt : w];
  });
  return { want, quietLead };
}
const minsAgo = (m: number) => (m < 60 ? `${m} min ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`);

/** A squad's repos, home first, then by name (as cb._repos_of). No repos: one repo, main, in each machine's repo folder. */
export function reposOf(squad: Squad): Record<string, Repo> {
  if (!squad.repos) return { main: { home: true, paths: Object.fromEntries(Object.entries(squad.machines).map(([k, m]) => [k, m.repo ?? ''])) } };
  return Object.fromEntries(Object.entries(squad.repos).sort(([a, x], [b, y]) => Number(!!y.home) - Number(!!x.home) || (a < b ? -1 : a > b ? 1 : 0)));
}
export const homeRepo = (squad: Squad) => Object.entries(reposOf(squad)).find(([, r]) => r.home)?.[0] ?? 'main';

// Names: the home repo keeps today's (demo-B1@m); another repo's builders and reviewers carry it (demo-dashboard-B1@m)
export function wantList(project: string, squad: Squad): Want[] {
  const want: Want[] = [], home = homeRepo(squad);
  for (const role of ORDER.filter((r) => squad.roles[r])) {
    const m = squad.roles[role].machine, count = squad.roles[role].count;
    if (role === 'lead') want.push({ name: `orch@${m}`, role, repo: home, seatKey: '1' });
    else if (role === 'owner') for (const a of squad.areas) {
      const area = typeof a === 'string' ? a : a.name;
      want.push({ name: `${project}-O-${area}@${m}`, role, area, repo: typeof a === 'string' ? home : a.repo, seatKey: area });
    }
    else if (role === 'builder' || role === 'reviewer') {
      const per = typeof count === 'object' ? count : { [home]: count ?? 1 };
      for (const repo of Object.keys(reposOf(squad))) for (let i = 1; i <= (per[repo] ?? 0); i++)
        want.push({ name: `${project}-${repo === home ? '' : `${repo}-`}${LETTER[role]}${i}@${m}`, role, repo, seatKey: squad.repos ? `${repo}:${i}` : String(i) });
    }
    else for (let i = 1; i <= (typeof count === 'number' ? count : 1); i++) want.push({ name: `${project}-${LETTER[role]}${i}@${m}`, role, repo: home, seatKey: String(i) });
  }
  return want;
}

/** A seat's agent, model, effort and fallback: the seat's own override the role's; a seat's fallback, when it has one,
 *  replaces the role's (as cb._expected_model reads them). No agent anywhere: claude. The role's effort goes only to a
 *  seat on the role's agent: the levels differ by agent. */
export function seatSpec(squad: Squad, w: Want): { agent: AgentKind; model: string; effort?: string; fallback?: Fallback } {
  const role = squad.roles[w.role]!, seat = role.seats?.[w.seatKey], fallback = seat?.fallback ?? role.fallback;
  const agent = seat?.agent ?? role.agent ?? 'claude';
  const effort = seat?.effort ?? (agent === (role.agent ?? 'claude') ? role.effort : undefined);
  return { agent, model: seat?.model ?? role.model, ...(effort ? { effort } : {}), ...(fallback ? { fallback } : {}) };
}
/** How a launch names what it runs: a Claude seat its model, as always; another agent agent/model. */
export const runsOn = (l: { agent: string; model: string }) => (l.agent === 'claude' ? l.model : `${l.agent}/${l.model}`);

// herdr agent names: a lowercase letter, then lowercase letters, digits, '-' or '_', 1-32 chars. The board name stays the actor.
export const herdrName = (name: string) => name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
const validHerdrName = (n: string) => /^[a-z][a-z0-9_-]{0,31}$/.test(n);

export function promptCommand(l: { herdr: string | null; name: string; prompt: string }) {
  return `herdr${l.herdr ? ` --machine ${l.herdr}` : ''} agent prompt ${herdrName(l.name)} "${l.prompt}"`;
}

/** #4429: the seat's relay runs getAdapter in the seat's own env, so a non-claude seat carries the launching machine's
 *  CB_MCP_GATE_OK (normalised as mcpGateOk reads it, agent names only: the restart hint single-quotes it). Unset, empty or no
 *  agent name: nothing, never a default. A Claude seat: nothing
 *  (claude has no MCP gate), so its launch stays as it was. */
export function gateEnv(agent: AgentKind, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const ok = [...mcpGateOk(env)].filter(isAgentKind).join(',');
  return agent !== 'claude' && ok ? { CB_MCP_GATE_OK: ok } : {};
}

/** #4585: an OpenCode seat's server port on its machine's loopback (the adapter needs CB_OPENCODE_PORT; the prestart writes
 *  it to the seat's endpoint file). From the seat's name, so a restart gets the same port: 41000-48999. */
export const opencodePort = (name: string) => 41000 + (parseInt(createHash('sha256').update(name).digest('hex').slice(0, 8), 16) % 8000);

// env: where CB_MCP_GATE_OK is read (gateEnv); squad up and the supervisor pass none, so it is this machine's
export function launchFor(project: string, squad: Squad, w: Want, first: 'next' | 'resume' = 'next', env: NodeJS.ProcessEnv = process.env): Launch {
  const machine = w.name.split('@')[1], mc = squad.machines[machine], repos = reposOf(squad), { agent, model, effort, fallback } = seatSpec(squad, w);
  // with repos: the session names its repo, and the architect and qa (who read across repos) get every repo's folder
  const across = squad.repos && (w.role === 'architect' || w.role === 'qa')
    ? `. Repos: ${Object.entries(repos).filter(([, r]) => r.paths[machine]).map(([k, r]) => `${k} ${r.paths[machine]}`).join(', ')}` : '';
  return {
    ...w, agent, model, ...(effort ? { effort } : {}), ...(fallback ? { fallback } : {}), machine, herdr: mc.herdr, board: mc.board, cwd: repos[w.repo]?.paths[machine] ?? '',
    ...(mc.workspace ? { workspace: mc.workspace } : {}),
    // CB_PROTECTED_BRANCHES last: the pane-making call ends with it, as before #4002
    env: { CB_ROLE: w.role, CB_AGENT: agent, ...gateEnv(agent, env), ...(agent === 'opencode' ? { CB_OPENCODE_PORT: String(opencodePort(w.name)) } : {}),
      ...(squad.protected?.length ? { CB_PROTECTED_BRANCHES: squad.protected.join(',') } : {}) },
    settings: `${mc.board.replace(/[\/]+$/, '')}/kit/permissions/${w.role}.json`,
    // --agent only for another agent than claude: a Claude seat's cb iam stays the 8-argument call (cli/iam-args.ts)
    prompt: `cb iam ${w.name} ${project} --role ${w.role}${w.area ? ` --area ${w.area}` : ''} --model ${model}${squad.repos ? ` --repo ${w.repo}` : ''}${agent !== 'claude' ? ` --agent ${agent}` : ''}, then cb role ${w.role}, then cb ${first}${across}`,
  };
}

// quiet: the sessions not live now (sessions_overview rows), read only to find a quiet lead
export function planSquad(project: string, squad: Squad, live: Live[], herdrAgents: Record<string, string[]>, macAgents = 0, quiet: Seen[] = []) {
  // the Mac cap counts by the herdr label: a machine whose herdr is 'macbook' is the Mac, whatever its key
  const isMac = (key: string) => key === MAC || squad.machines[key]?.herdr === MAC;
  const running = new Set([...live.map((l) => l.actor), ...Object.values(herdrAgents).flat()]);
  // every session already on the Mac, any project, counts toward the cap
  // macAgents = how many agents herdr itself lists on the Mac (catches quiet or unnamed ones)
  let mac = Math.max(new Set([...live.filter((l) => isMac(l.machine)).map((l) => l.actor),
    ...Object.entries(herdrAgents).filter(([k]) => isMac(k)).flatMap(([, v]) => v)]).size, macAgents);
  const { want, quietLead } = wantNow(project, squad, live, quiet);
  const out = { start: [] as Launch[], skip: [] as string[], refused: [] as string[], heldBy: {} as Record<string, string>, herdrOnly: [] as Launch[], quietLead };
  for (const w of want) {
    const machine = w.name.split('@')[1];
    const l = launchFor(project, squad, w);
    const onBoard = live.find((x) => x.actor === w.name);
    if (onBoard) {
      out.skip.push(w.name);
      if (w.role === 'lead' && onBoard.project && onBoard.project !== project) out.heldBy[w.name] = onBoard.project;
      continue;
    }
    if (running.has(w.name)) { out.skip.push(w.name); out.herdrOnly.push(l); continue; }
    if (isMac(machine) && mac >= MAC_CAP) { out.refused.push(w.name); continue; }
    if (isMac(machine)) mac++;
    out.start.push(l);
  }
  return out;
}

type Res = { status: number | null; stdout?: string | null; stderr?: string | null; error?: Error };
export type Runner = (m: string | null, args: string[], timeout?: number) => Res;
export const realRun: Runner = (m, args, timeout = 180_000) => spawnSync('herdr', [...(m ? ['--machine', m] : []), ...args], { encoding: 'utf8', timeout, windowsHide: true }); // review 98 I2: a relay has no console, and herdr.exe is a console program: without it every call opens a window

// `herdr agent get <name>`: exit 0 = running, agent_not_found = not running, anything else = could not tell.
export function classifyAgentGet(r: { status: number | null; stderr?: string | null; error?: unknown }): 'live' | 'absent' | 'unknown' {
  if (r.error) return 'unknown';
  if (r.status === 0) return 'live';
  return r.status === 1 && /agent_not_found/.test(r.stderr ?? '') ? 'absent' : 'unknown';
}

export const find = (o: any, key: string): any => {
  if (o && typeof o === 'object') {
    if (key in o) return o[key];
    for (const v of Object.values(o)) { const f = find(v, key); if (f !== undefined) return f; }
  }
};

/** One herdr call: its JSON (null when not JSON); throws herdr's own error text on a non-zero exit. */
export function herdrJson(run: Runner, m: string | null, args: string[], timeout?: number) {
  const r = run(m, args, timeout);
  if (r.status !== 0) throw new Error((r.error?.message || r.stderr || r.stdout || 'herdr failed').trim());
  try { return JSON.parse(r.stdout ?? ''); } catch { return null; }
}

/** #4576: what a seat CLI that exits at start said, as one short line for the failure (an unknown flag after a CLI
 *  update only makes herdr time out). The line goes to squad up's output and the supervisor log, so it is an allowlist
 *  (PR 93 review M1, M2): only lines that read as a CLI error, and in them only plain words and flag-shaped flags
 *  (--lower-case-words up to 60 characters, -x), each kept whole (the flag is the point). Anything else, a number, a
 *  path, an address, a key, a quoted value, a flag's =value and the word after a secret-sounding word or an account
 *  name (token, key, pass, auth, cred, user, profile, -p: #4617), becomes '…'. '' when the pane cannot be read or shows
 *  no error line. */
const PANE_LINES = 8, PANE_LINE_MAX = 120;
const ERROR_LINE = /\b(?:error|usage|unknown|unexpected|unrecognized|invalid|not found|no such|panic|fatal|failed|denied|unauthorized|refused)\b/i;
const WORD = /^[A-Za-z]{1,24}(?:'[A-Za-z]{1,3})?$/;
// #4617 S1: a flag's shape, not anything after a dash (-aB3dEf9, -pPassword): a long flag is lower-case words joined by
// dashes, at most 60 characters; a short flag is one letter
const LONG_FLAG = /^--[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const isFlag = (t: string) => (LONG_FLAG.test(t) && t.length <= 62) || /^-[A-Za-z]$/.test(t);
// #4617 L1, PR 105 review B4: a word that names a secret or an account opens a context, and the next value in it is cut
// (API_KEY: x, access_token x, passphrase x, credentials x, user x, mysql -p x, --username x). A secret word is a whole
// word or a part of a compound (accessToken, AUTH_TOKEN, client-secret, apikey), never a piece of an ordinary word:
// passed, keyboard, author, credit, bypass and oauth are not secrets
const SECRET_PARTS = new Set(['token', 'tokens', 'key', 'keys', 'apikey', 'privatekey', 'secret', 'secrets', 'password', 'passwords', 'passwd',
  'passphrase', 'pass', 'pwd', 'auth', 'authorization', 'credential', 'credentials', 'cred', 'creds', 'bearer', 'cookie', 'signature']);
const NAMES = new Set(['basic', 'profile', 'user', 'username', 'account', 'org', 'organization', 'login', 'email', 'tenant', 'p', 'u']);
const secretWord = (w: string) => w.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z]+/).some((x) => SECRET_PARTS.has(x.toLowerCase()));
// B3: an account name given as a flag (--user, --username, --profile, -p) counts as the name
const valueNext = (w: string) => secretWord(w) || NAMES.has(w.replace(/^-+/, '').toLowerCase());
// what went wrong is never a value: these end the context and stay (error: auth failed, password is missing)
const OUTCOME = /^(?:error|usage|unknown|unexpected|unrecognized|invalid|not|found|no|such|panic|fatal|failed|denied|unauthorized|refused|rejected|expired|missing|required|empty|unset|wrong|bad)$/i;
// B5: these sit between the word and its value (password is x, token was x, the key is set to x) and keep the context
const LINKING = new Set(['is', 'was', 'are', 'were', 'be', 'been', 'set', 'to', 'as', 'now', 'currently', 'still', 'the', 'a', 'an']);
const LEAD = /^[\[({'"`‘“«]*/, TRAIL = /[\])}'"`’”»,.:;!?]*$/; // L3: curly quotes too
// B7: a line is cut before it is cleaned, so no pattern runs over more than this
const PANE_RAW_MAX = 1000;
function cleanToken(lead: string, core: string, trail: string): string {
  const eq = core.indexOf('=');
  if (eq > 0 && isFlag(core.slice(0, eq))) return `${lead}${core.slice(0, eq)}=…`;
  return core && (isFlag(core) || WORD.test(core)) ? lead + core + trail : '…';
}
function cleanLine(line: string): string {
  let open = false; // a secret or account word came before, and its value has not
  const out: string[] = [];
  const push = (t: string) => { if (!(t === '…' && out[out.length - 1] === '…')) out.push(t); };
  for (const tok of line.split(/\s+/).filter(Boolean)) {
    const lead = LEAD.exec(tok)![0], rest = tok.slice(lead.length);
    const trail = TRAIL.exec(rest)![0], core = rest.slice(0, rest.length - trail.length);
    // B1: punctuation alone (: = - :=) is shown as … and leaves the context as it was (password : x)
    if (!/[A-Za-z0-9]/.test(core)) { push('…'); continue; }
    if (open) {
      if (LINKING.has(core.toLowerCase())) { push(cleanToken(lead, core, trail)); continue; }
      const outcome = OUTCOME.test(core);
      // #4679: a scheme or another secret word cut here (Authorization: Bearer x) is not the value: the next one is
      open = !outcome && (secretWord(core) || /^basic$/i.test(core));
      push(outcome ? cleanToken(lead, core, trail) : '…');
      continue;
    }
    push(cleanToken(lead, core, trail));
    open = core.indexOf('=') <= 0 && valueNext(core); // --token=x: its value is already cut
  }
  const l = out.join(' ');
  return l.length > PANE_LINE_MAX ? `${l.slice(0, PANE_LINE_MAX)}…` : l;
}
export function paneTail(run: Runner, m: string | null, pane: string): string {
  let r: Res;
  try { r = run(m, ['pane', 'read', pane, '--source', 'recent', '--lines', '40', '--format', 'text'], 10_000); } catch { return ''; }
  if (r.status !== 0 || !r.stdout) return '';
  // #4617 L2, PR 105 review B2: every control character but the line end is a space (a tab, vertical tab, form feed or
  // bare CR glued a value onto the word before it); B7: each line is cut to PANE_RAW_MAX before anything reads it
  return String(r.stdout).slice(-PANE_RAW_MAX * 40).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .split('\n').map((s) => s.slice(0, PANE_RAW_MAX).trim()).filter((s) => s && ERROR_LINE.test(s))
    .map(cleanLine).slice(-PANE_LINES).join(' | ');
}

// A pane herdr just made refuses agent start (agent_pane_busy) until its shell prompt is up: about 10 s of retries.
const BUSY_TRIES = 6, BUSY_WAIT_MS = 2000;

// #4687: a TUI can drop a paste that comes the moment herdr agent start returns (OpenCode 1.19.4 did: its input box
// stayed empty, the seat never ran cb iam). So the first prompt waits until the agent starts working; herdr says
// agent_prompt_stalled when it does not within 5 s. A stall is not proof the text was lost (the status can lag, or the
// text sits in the input box with its Enter not taken), so herdr's status and the visible screen are read first: the
// text is sent once more only when that read worked and the prompt is not on it. A second prompt that lands would have
// cb next take a second card (PR 117 B1), and one typed after a first still in the box goes as one joined message
// (#4716), so a prompt on the screen gets Enter alone. Enter also answers a dialog: it goes only to an agent herdr shows
// idle or done. Anything less certain (a read that fails or comes back empty, herdr's own timeout, which counts the
// submit time over a slow --machine relay) sends nothing more: the line asks a person to check the pane. Every agent kind.
const UNTIL_STARTED = ['--until', 'working', '--until', 'blocked', '--timeout', '20000'];
const PROMPT_WAIT = ['--wait', ...UNTIL_STARTED];
const PROMPT_RETRY_MS = 3000;
const STALLED = /agent_prompt_stalled/i;
const TIMED_OUT = /\btimeout\b|timed out/i;
// without spaces, line ends and the box borders and bars a TUI draws (U+2500-U+259F)
const flat = (t: string) => t.replace(/[\s\u2500-\u259f]+/g, '');
/** The prompt's start or end is on the screen (an input box shows only the end of a long line when it scrolls). Each
 *  row loses its prompt mark and ASCII border first, so a wrapped line reads as one. */
function promptOnScreen(screen: string, text: string): boolean {
  const shown = screen.split('\n').map((row) => flat(row).replace(/^[|>›❯]+/, '').replace(/\|$/, '')).join('');
  const want = flat(text);
  return shown.includes(want.slice(0, 24)) || shown.includes(want.slice(-24));
}
/** 'ok' once the agent took the prompt; 'unconfirmed' when that is not known (a person checks the pane). Other herdr
 *  errors throw (the prompt was not sent). */
function sendFirstPrompt(l: Launch, text: string, pane: string, run: Runner, pause: (ms: number) => void): 'ok' | 'unconfirmed' {
  const send = (): 'ok' | 'stalled' | 'unconfirmed' => {
    const r = run(l.herdr, ['agent', 'prompt', herdrName(l.name), text, ...PROMPT_WAIT], 30_000);
    if (r.status === 0) return 'ok';
    const why = (r.error?.message || r.stderr || r.stdout || 'herdr failed').trim();
    if (STALLED.test(why)) return 'stalled';
    if (TIMED_OUT.test(why)) return 'unconfirmed';
    throw new Error(why);
  };
  const first = send();
  if (first !== 'stalled') return first;
  pause(PROMPT_RETRY_MS);
  let status = '';
  try { status = String(find(herdrJson(run, l.herdr, ['agent', 'get', herdrName(l.name)], 10_000), 'agent_status') ?? ''); } catch { /* unknown */ }
  if (status === 'working') return 'ok';
  if (status === 'blocked') return 'unconfirmed'; // a dialog, or a question about the prompt: a person looks
  // S1: the visible screen (a TUI's own rows), not the last lines of scrollback
  let screen = '';
  try {
    const r = run(l.herdr, ['pane', 'read', pane, '--source', 'visible', '--format', 'text'], 10_000);
    if (r.status === 0) screen = String(r.stdout ?? '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
  } catch { /* unread: unknown */ }
  if (!screen.trim()) return 'unconfirmed';
  if (!promptOnScreen(screen, text)) return send() === 'ok' ? 'ok' : 'unconfirmed';
  if (status !== 'idle' && status !== 'done') return 'unconfirmed';
  // on an empty box (the prompt had landed) Enter does nothing
  if (run(l.herdr, ['agent', 'send-keys', herdrName(l.name), 'enter'], 10_000).status !== 0) return 'unconfirmed';
  return run(l.herdr, ['agent', 'wait', herdrName(l.name), ...UNTIL_STARTED], 30_000).status === 0 ? 'ok' : 'unconfirmed';
}
const sleep = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** A launch's adapter and native command, as startOne makes them before any pane. Throws an agent not installed, one
 *  whose MCP check is not confirmed here, or a model its adapter refuses (#4332: the supervisor asks before a restart). */
// gate: for tests only, getAdapter's options (an installed set in place of INSTALLED, the env CB_MCP_GATE_OK is read from)
export type AdapterGate = { installed?: ReadonlySet<AgentKind>; env?: NodeJS.ProcessEnv };
export function launchSpec(l: Launch, gate: AdapterGate = {}): { adapter: AgentAdapter; spec: LaunchSpec } {
  const adapter = getAdapter(l.agent, gate);
  return { adapter, spec: adapter.buildLaunch({ name: l.name, role: l.role, area: l.area, repo: l.repo, agent: l.agent, model: l.model, effort: l.effort, board: l.board, cwd: l.cwd, env: l.env }) };
}

const PRESTART_WORD = /^[A-Za-z0-9._:][A-Za-z0-9._:-]{0,63}$/; // never a leading -: pwsh would read it as a parameter name
/** The pane's shell as prestart needs it: 'pwsh', 'posix' (bash, zsh), another name, or '' while the pane is starting. */
export function paneShell(info: unknown): string {
  const p = find(info, 'foreground_processes')?.[0];
  const name = String(p?.argv0 ?? p?.name ?? '').split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '').replace(/^-/, '');
  return /^(?:pwsh|powershell)$/.test(name) ? 'pwsh' : /^(?:bash|zsh)$/.test(name) ? 'posix' : name;
}
/** The line that dot-sources the seat prestart in this shell: plain words only, the board path single-quoted. */
export function prestartLine(shell: 'pwsh' | 'posix', board: string, words: string[]): string {
  const b = board.replace(/[\\/]+$/, '');
  // pwsh also reads the curly single quotes as quotes
  if (!b || /['‘’‚‛\r\n]/.test(b)) throw new Error('prestart: the board path is empty or holds a quote or line break');
  const bad = words.find((w) => !PRESTART_WORD.test(w));
  if (bad !== undefined) throw new Error(`prestart: ${JSON.stringify(bad)} is not a plain word`);
  const [agent, machine, pane, nonce, port] = words;
  return shell === 'pwsh'
    ? `. '${b}/kit/seat/prestart.ps1' -Board '${b}' -Agent ${agent} -Machine ${machine} -Pane ${pane} -Nonce ${nonce}${port ? ` -Port ${port}` : ''}`
    : `. '${b}/kit/seat/prestart.sh' '${b}' ${words.join(' ')}`;
}
/** #4002 install gates: herdr --env only adds to the pane's env, which herdr's own process fills (a token, CLAUDE_CODE_*,
 *  ANTHROPIC_* on this PC). So before a non-Claude agent starts, its pane's shell runs the seat prestart: the Claude-only
 *  names go from the shell itself, OpenCode's password is made there (never on argv), and a child of that shell checks the
 *  env and that the guard will run. Throws unless it prints cb-seat-ready: the caller closes the pane. */
function prestartPane(l: Launch, pane: string, args: string[], run: Runner, pause: (ms: number) => void) {
  const herdr = (a: string[], timeout?: number) => herdrJson(run, l.herdr, a, timeout);
  let shell = '';
  for (let i = 1; ; i++) {
    shell = paneShell(herdr(['pane', 'process-info', '--pane', pane]));
    if (shell === 'pwsh' || shell === 'posix') break;
    if (shell || i >= BUSY_TRIES) throw new Error(`prestart: the pane's shell is ${shell ? `"${shell}"` : 'not up'}: only pwsh, bash and zsh can drop the Claude-only env`);
    pause(BUSY_WAIT_MS);
  }
  const nonce = randomBytes(6).toString('hex'); // the answer names it: an older line in the pane never counts
  herdr(['pane', 'run', pane, prestartLine(shell as 'pwsh' | 'posix', l.board, [l.agent, l.machine, pane, nonce, ...args])]);
  const r = herdr(['pane', 'wait-output', pane, '--regex', `cb-seat-(?:ready|refused):${nonce}[^\\r\\n]*`, '--timeout', '30000'], 40_000);
  const line = String(find(r, 'matched_line') ?? '').trim();
  if (line !== `cb-seat-ready:${nonce}`) throw new Error(`prestart: ${line.replace(`:${nonce}`, '') || 'no answer'}`);
}

/** Start one session: a pane (a new tab, or a split of a tab in `tabs`, two panes per tab), the agent its adapter
 *  launches, its first prompt. ok: the agent is up (blocked: up but waiting on a startup dialog; the pane is kept). A
 *  launch that did not come up has its own pane closed, never any other. "started, prompt not sent" is ok: false with
 *  its pane. An agent with no adapter fails before any pane. */
export function startOne(l: Launch, run: Runner, tabs: Record<string, { pane: string; panes: number }>, pause: (ms: number) => void = sleep, gate: AdapterGate = {}): { line: string; pane?: string; blocked?: boolean; unconfirmed?: boolean; ok: boolean } {
  const herdr = (m: string | null, args: string[], timeout?: number) => herdrJson(run, m, args, timeout);
  if (!validHerdrName(herdrName(l.name))) return { ok: false, line: `failed ${l.name}: herdr name ${herdrName(l.name)} is invalid` };
  // the seat's agent adapter, before any pane (#4002): an agent without one fails here, never started as Claude instead
  let adapter: AgentAdapter, spec: LaunchSpec;
  try { ({ adapter, spec } = launchSpec(l, gate)); } catch (e) { return { ok: false, line: `failed ${l.name}: ${(e as Error).message}` }; }
  let pane: string | undefined, started = false, starting = false;
  // the launch's env goes on every call that makes its pane: herdr starts the agent there, and the agent inherits it
  const env = Object.entries(spec.env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  try {
    const t = tabs[l.machine];
    if (t && t.panes < 2) pane = find(herdr(l.herdr, ['pane', 'split', '--pane', t.pane, '--direction', 'right', '--cwd', l.cwd, '--no-focus', ...env]), 'pane_id');
    else if (l.workspace) {
      // the squad's workspace by label; missing: made here, and its first pane takes this session
      const list = find(herdr(l.herdr, ['workspace', 'list']), 'workspaces');
      if (!Array.isArray(list)) throw new Error('herdr workspace list gave no workspaces'); // never a second workspace by mistake
      const ws = list.find((w: any) => w.label === l.workspace)?.workspace_id;
      pane = ws ? find(herdr(l.herdr, ['tab', 'create', '--workspace', ws, '--cwd', l.cwd, '--label', l.name, '--no-focus', ...env]), 'pane_id')
        : find(find(herdr(l.herdr, ['workspace', 'create', '--cwd', l.cwd, '--label', l.workspace, '--no-focus', ...env]), 'root_pane'), 'pane_id');
    }
    else pane = find(herdr(l.herdr, ['tab', 'create', '--cwd', l.cwd, '--label', l.name, '--no-focus', ...env]), 'pane_id');
    if (!pane) throw new Error('herdr returned no pane id');
    if (spec.prestart) prestartPane(l, pane, spec.prestart.args, run, pause);
    let blocked = false;
    starting = true; // from here a failure is the agent's: its pane is read before it is closed (#4576)
    try {
      for (let i = 1; ; i++) {
        try {
          herdr(l.herdr, ['agent', 'start', herdrName(l.name), '--kind', spec.kind, '--pane', pane, '--timeout', '120000', '--', ...spec.args]);
          break;
        } catch (e) {
          // agent_pane_busy: the new pane's shell is not up yet (a split made a moment ago, a slow shell profile)
          if (i >= BUSY_TRIES || !/agent_pane_busy/.test((e as Error).message)) throw e;
          pause(BUSY_WAIT_MS);
        }
      }
    } catch (e) {
      // agent_not_ready: the agent waits on a startup dialog (Claude Code: folder trust, bypass warning). It exists: keep the pane.
      if (!/agent_not_ready/.test((e as Error).message)) throw e;
      blocked = true;
    }
    started = true;
    if (t && t.panes < 2) t.panes++; else tabs[l.machine] = { pane, panes: 1 }; // tab state only once the agent is up
    // the hint names the agent's own dialog; the platform is this machine's (a dialog's name does not depend on it for claude)
    if (blocked) return { ok: true, blocked, pane, line: `blocked ${l.name}: a startup dialog is waiting (${adapter.trustSpec([l.cwd], process.platform).dialogHint}). Answer it in herdr pane ${pane}${l.herdr ? ` on ${l.herdr}` : ''}, then run: ${promptCommand(l)}` };
    if (sendFirstPrompt(l, adapter.promptText?.(l.prompt) ?? l.prompt, pane, run, pause) === 'unconfirmed')
      return { ok: false, unconfirmed: true, pane, line: `started ${l.name}, its first prompt may not have landed (the agent did not start working): check herdr pane ${pane}${l.herdr ? ` on ${l.herdr}` : ''}, then send it if it is not there: ${promptCommand(l)}` };
    return { ok: true, pane, line: `started ${l.name}` };
  } catch (e) {
    if (started) return { ok: false, pane, line: `started ${l.name}, prompt not sent: ${promptCommand(l)}` };
    const shown = pane && starting ? paneTail(run, l.herdr, pane) : '';
    if (pane) try { herdr(l.herdr, ['pane', 'close', pane]); } catch {}
    return { ok: false, line: `failed ${l.name}: ${(e as Error).message}${shown ? `; the CLI said: ${shown}` : ''}` };
  }
}

// trust (#4575): a seat whose folder its agent does not trust yet stops here, before any pane, instead of parking at the
// trust dialog. Read from this machine's home for a real herdr; a fake one (tests) opens no real pane, so none unless given.
export async function squadUp(project: string, dryRun: boolean, callFn: (fn: string, a: any) => Promise<unknown>, run: Runner = realRun,
  trust: TrustCheck | null = run === realRun ? homeTrust() : null): Promise<string> {
  const herdr = (m: string | null, args: string[], timeout?: number) => herdrJson(run, m, args, timeout);
  const squad = await callFn('squad_get', { project }) as Squad | null;
  if (!squad) throw new Error(`${project} has no squad yet: write one with cb squad set ${project} -f <file>`);
  // #4559: a disabled or archived project starts no seats (its squad can still be edited on Project settings)
  const st = await callFn('project_state_preview', { project }) as { state?: unknown; words?: string } | null;
  if (typeof st?.state === 'string' && st.state !== 'enabled') throw new Error(`${st.words}; Ahmed enables it on Projects first, then cb squad up ${project}`);
  const rows = await callFn('sessions_overview', { project: null }) as any[];
  const live = rows.filter((r) => r.live).map((r) => ({ actor: r.actor as string, machine: (r.actor.split('@')[1] ?? r.machine) as string,
    project: (r.project ?? null) as string | null, role: (r.role ?? null) as string | null }));
  const quiet = rows.filter((r) => !r.live).map((r) => ({ actor: r.actor as string, project: (r.project ?? null) as string | null,
    role: (r.role ?? null) as string | null, last_seen: (r.last_seen ?? null) as string | null }));
  const lines: string[] = [];
  let macAgents = 0, macDown = false;
  const macKey = Object.keys(squad.machines).find((k) => squad.machines[k].herdr === MAC);
  if (macKey) {
    try { macAgents = (find(herdr(MAC, ['agent', 'list'], 30_000), 'agents') ?? []).length; } catch { macDown = true; }
  }
  const isMac = (k: string) => k === MAC || squad.machines[k]?.herdr === MAC;
  // Ask herdr about EVERY wanted name that is not live on the board (a quiet session is live in herdr only), then plan once.
  const herdrAgents: Record<string, string[]> = {};
  const unknown = new Set<string>();
  const onBoard = new Set(live.map((l) => l.actor));
  for (const w of wantNow(project, squad, live, quiet).want) {
    if (onBoard.has(w.name)) continue;
    const machine = w.name.split('@')[1];
    if (isMac(machine) && macDown) { unknown.add(w.name); continue; }
    if (!validHerdrName(herdrName(w.name))) continue; // fails at launch with a clear line
    const c = classifyAgentGet(run(squad.machines[machine].herdr, ['agent', 'get', herdrName(w.name)], 30_000));
    if (c === 'live') (herdrAgents[machine] ??= []).push(w.name);
    else if (c === 'unknown') unknown.add(w.name);
  }
  const plan = planSquad(project, squad, live, herdrAgents, macAgents, quiet);
  const toStart = plan.start.filter((l) => !unknown.has(l.name));
  for (const l of plan.start) if (unknown.has(l.name)) lines.push(`skip ${l.name}: could not check herdr on ${l.machine}`);
  const q = plan.quietLead;
  // neither squad up nor the supervisor starts it, so its pane gets no env from them: the line says how (#3746, #4002): the
  // role (the guard reads CB_ROLE), the agent (the lead role's, claude by default), a non-claude lead's CB_MCP_GATE_OK and the
  // protected list, in launchFor's order.
  // Single-quoted: no shell expands the * (zsh would refuse an unmatched glob); list entries never hold a quote
  const leadAgent = squad.roles.lead?.agent ?? 'claude';
  const envFlags = [`CB_ROLE=lead`, `CB_AGENT=${leadAgent}`, ...Object.entries(gateEnv(leadAgent)).map(([k, v]) => `${k}=${v}`), ...(squad.protected?.length ? [`CB_PROTECTED_BRANCHES=${squad.protected.join(',')}`] : [])];
  const how = `in a tab made with herdr tab create ${envFlags.map((e) => `--env '${e}'`).join(' ')}`;
  if (q) lines.push(`skip lead: ${q.actor} leads ${project} but is not live (last seen ${minsAgo(q.mins)}): restart it by hand ${how}, or cb iam <name> ${project} --role lead`);
  const herdrOnly = new Set(plan.herdrOnly.map((l) => l.name));
  for (const n of plan.skip) {
    if (plan.heldBy[n]) lines.push(`skip ${n}: lead name held by project ${plan.heldBy[n]}`);
    else if (!herdrOnly.has(n)) lines.push(`skip ${n}: live`);
  }
  for (const l of plan.herdrOnly) lines.push(`skip ${l.name}: running in herdr but not on the board (not bound?)`, `  ${promptCommand(l)}`);
  for (const n of plan.refused) lines.push(`refused ${n}: the Mac already has ${MAC_CAP} live sessions`);
  const untrusted = new Map(toStart.map((l) => [l.name, trust?.(l, project) ?? null]));
  for (const l of toStart) {
    if (untrusted.get(l.name)) { lines.push(`failed ${l.name}: ${untrusted.get(l.name)}`); continue; }
    lines.push(`start ${l.name} (${l.role}, ${runsOn(l)}) on ${l.machine}`);
    // #4585: a dry run says what startOne would refuse here (MCP gate, model, port), before any pane
    if (dryRun) try { launchSpec(l); } catch (e) { lines.push(`  would fail: ${(e as Error).message}`); }
  }
  if (dryRun) return lines.join('\n');
  // Only tabs made in this run are reused: two panes per tab, never an existing pane.
  const tabs: Record<string, { pane: string; panes: number }> = {};
  for (const l of toStart) if (!untrusted.get(l.name)) lines.push(startOne(l, run, tabs).line);
  return lines.join('\n');
}
