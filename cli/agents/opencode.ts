// The OpenCode adapter (#4002 phase 3). Pure: no database. OpenCode runs its TUI and a loopback HTTP server in one process
// (`opencode <dir> --port <p>`); the relay (on the seat's own machine) reaches it through an endpoint file written before
// the pane starts the agent, like Claude's. The password lives only in that file and the pane env: never logged, never in argv
// (#4002: the pane prestart makes it on the seat's machine; buildLaunch refuses one in the launch env, which herdr's --env puts on argv).
import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { seatKey } from '../bridge.ts';
import { stripClaudeOnly, withNoPrompt } from './env.ts';
import { checkedEffort } from './effort.ts';
import type { AgentAdapter, AgentState, LaunchInput, QuotaSignal, SeatHandle } from './types.ts';
import { atBannerSpot } from './screen.ts';

export type OpencodeEndpoint = { port: number; password: string; username?: string; updatedAt: number };
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** provider/model, the spec's section 3 regex for opencode (cb._check_model). */
export const OPENCODE_MODEL = /^[a-z0-9][a-z0-9._-]{0,31}\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/;
export const opencodeEndpointPath = (machine: string, pane: string) => join(tmpdir(), `cb-seat-${seatKey(machine, pane)}.opencode.json`);

const USERNAME = /^[A-Za-z0-9._-]+$/; // a ":" would break Basic auth
const validPort =(p: unknown): p is number => typeof p === 'number' && Number.isInteger(p) && p >= 1024 && p <= 65535;

/** Atomic and 0600: a reader sees the old file or the new one. The caller (squad-up, before `herdr agent start`) picks the port and password. */
export function writeOpencodeEndpoint(machine: string, pane: string, ep: { port: number; password: string; username?: string }): void {
  if (!validPort(ep.port) || !ep.password) throw new Error('opencode endpoint needs a port 1024-65535 and a password');
  if (ep.username !== undefined && !USERNAME.test(ep.username)) throw new Error('opencode endpoint username must match [A-Za-z0-9._-]+');
  const file = opencodeEndpointPath(machine, pane), tmp = `${file}.tmp.${process.pid}`;
  try {
    rmSync(tmp, { force: true });
    writeFileSync(tmp, JSON.stringify({ port: ep.port, password: ep.password, username: ep.username, updatedAt: Date.now() }), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

export function readOpencodeEndpoint(machine: string, pane: string): OpencodeEndpoint | null {
  try {
    const o = JSON.parse(readFileSync(opencodeEndpointPath(machine, pane), 'utf8'));
    if (!o || !validPort(o.port) || typeof o.password !== 'string' || !o.password) return null;
    if (o.username !== undefined && o.username !== null && !(typeof o.username === 'string' && USERNAME.test(o.username))) return null;
    return { port: o.port, password: o.password, username: typeof o.username === 'string' ? o.username : undefined, updatedAt: Number(o.updatedAt) || 0 };
  } catch { return null; }
}

export function clearOpencodeEndpoint(machine: string, pane: string): void {
  try { rmSync(opencodeEndpointPath(machine, pane), { force: true }); } catch {}
}

export type FreellmRule = { root: string; allowed: string[]; git?: (cwd: string) => { ok: boolean; notRepo?: boolean; dir?: string } };

/** The folder rule lives on each machine, outside the repo: `~/.claude-board/freellm-rule.json` (or the file CB_FREELLM_RULE
 *  names) = `{ "root": "<protected folder>", "allowed": ["<folder>", ...] }`. Missing or malformed = null, and freellmRefusal()
 *  then refuses (fail closed): a machine without the file never sends code to the free router. */
export function loadFreellmRule(path = process.env.CB_FREELLM_RULE || join(homedir(), '.claude-board', 'freellm-rule.json')): FreellmRule | null {
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as { root?: unknown; allowed?: unknown } | null;
    if (!o || typeof o !== 'object') return null;
    const { root, allowed } = o;
    if (typeof root !== 'string' || !root.trim()) return null;
    if (!Array.isArray(allowed) || !allowed.every((a): a is string => typeof a === 'string' && a.trim() !== '')) return null;
    return { root, allowed };
  } catch {
    return null;
  }
}

/** An absolute, normalised path (forward slashes), or null when empty, relative or unresolvable. Handles `\\?\X:\..`, `/x/work/..`
 *  (Git Bash) and `..` segments, like [IO.Path]::GetFullPath in the freellm wrapper (which this cannot call from here). */
export function normalizeAbs(p: unknown): string | null {
  if (typeof p !== 'string' || !p.trim()) return null;
  let s = p.trim().replace(/\\/g, '/');
  s = s.replace(/^\/\/\?\/(?:UNC\/)?/i, (m) => (/unc/i.test(m) ? '//' : ''));
  s = s.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:'); // /f/work -> f:/work
  if (/^[a-zA-Z]:$/.test(s)) s += '/';
  if (!/^[a-zA-Z]:\//.test(s) && !s.startsWith('/')) return null;
  if (s.includes('\0')) return null;
  const out = posix.normalize(s);
  return /^[a-zA-Z]:\/$/.test(out) || out.length <= 1 ? out : out.replace(/\/+$/, '');
}
const under = (p: string, root: string) => (p.toLowerCase() + '/').startsWith(root.toLowerCase().replace(/\/+$/, '') + '/');

function realGit(cwd: string) {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 10_000 });
  if (r.error) return { ok: false };
  if (r.status === 0) return { ok: true, dir: String(r.stdout).trim() };
  return /not a git repository/i.test(String(r.stderr)) ? { ok: true, notRepo: true } : { ok: false };
}

/** The local freellm wrapper's folder rule, mirrored and fail closed: the free router may train on what it sees, so under the
 *  protected root only the allowed folders. Judged on the cwd AND on the repo's git common dir (a worktree elsewhere belongs to
 *  its repo). Null when allowed, else the refusal. No rule on this machine, an empty, relative or unresolvable cwd, or a git
 *  failure inside a repo, refuses (the wrapper itself ignores a git error). */
export function freellmRefusal(cwd: string, rule: FreellmRule | null = loadFreellmRule()): string | null {
  const refuse = (why: string) => `freellmapi refused for ${JSON.stringify(cwd)}: ${why}`;
  if (!rule) return refuse('this machine has no folder rule (~/.claude-board/freellm-rule.json), so free providers stay off');
  const here = normalizeAbs(cwd), root = normalizeAbs(rule.root);
  if (!here) return refuse('the folder is empty, relative or cannot be resolved');
  if (!root) return refuse('the protected root cannot be resolved');
  const allowed = rule.allowed.map(normalizeAbs);
  if (allowed.some((a) => !a)) return refuse('an allowed folder cannot be resolved');
  const g = (rule.git ?? realGit)(here);
  if (!g.ok) return refuse('git could not say which repository this folder belongs to');
  const paths = [here];
  if (!g.notRepo) {
    const d = normalizeAbs(g.dir);
    if (!d) return refuse('git gave no usable repository path');
    paths.push(d);
  }
  for (const p of paths) {
    if (under(p, root) && !allowed.some((a) => under(p, a!))) {
      return refuse(`${p} is under ${rule.root}: free providers may keep or train on code, so only ${rule.allowed.join(' and ')} are allowed there`);
    }
  }
  return null;
}

/** The env the caller gave, minus Claude-only secrets (a non-Claude seat never inherits them; the list in env.ts). */
export const opencodeEnv = (env: Record<string, string> = {}): Record<string, string> => stripClaudeOnly(env);

const STATES = new Set<string>(['idle', 'working', 'blocked', 'done']);
// Only the last TAIL_LINES lines are read, and a bare "429" or "rate limit" is not enough: a banner needs error wording around it.
const TAIL_LINES = 8;
const QUOTA = /FreeUsageLimitError|insufficient[_ ]quota|(?:usage|free) limit (?:reached|exceeded)|quota (?:exceeded|exhausted)|out of credits|credit balance is too low/i;
const RATE = /rate[ _-]?limit(?:ed| reached| exceeded| error)|(?:http|status|error|code)[ :=]{0,3}429\b|\b429[ :]{1,3}too many requests|too many requests|retrying in \d+/i;
const RETRY = /(?:retry(?:ing)?|try again) (?:in|after) (\d+)\s*(s|sec|seconds|m|min|minutes)\b/i;
// #4787: the limit message at the start of its line, alone or behind the error's name
const BANNER = /^[ \t]*(?:(?:Error|AI_APICallError):[ \t]*)?(?:FreeUsageLimitError|you exceeded your current quota|insufficient[_ ]quota|(?:usage|free) limit (?:reached|exceeded)|quota (?:exceeded|exhausted)|out of credits|(?:your )?credit balance is too low)/i;

const auth = (ep: OpencodeEndpoint) => 'Basic ' + Buffer.from(`${ep.username || 'opencode'}:${ep.password}`).toString('base64');
const base = (ep: OpencodeEndpoint) => `http://127.0.0.1:${ep.port}`;
const TIMEOUT = 5000;

/** The newest ROOT session (no parentID: a subagent's child session is never the seat's) of an expected v1 `GET /session` answer:
 *  an array, or { data | items: [...] }. */
export function newestSession(body: unknown): string | null {
  const b = body as any;
  const list = Array.isArray(b) ? b : Array.isArray(b?.data) ? b.data : Array.isArray(b?.items) ? b.items : [];
  let best: { id: string; t: number } | null = null;
  for (const s of list) {
    if (!s || typeof s.id !== 'string' || s.parentID || s.parentId) continue;
    const t = Number(s.time?.updated ?? s.time?.created ?? s.updated ?? 0) || 0;
    if (!best || t >= best.t) best = { id: s.id, t };
  }
  return best?.id ?? null;
}

export function makeOpencodeAdapter(f: Fetch = (u, i) => fetch(u, i), readEp: typeof readOpencodeEndpoint = readOpencodeEndpoint, rule?: FreellmRule | null): AgentAdapter {
  // redirect 'error': the Authorization header never follows a redirect
  const call = (ep: OpencodeEndpoint, path: string, init: RequestInit = {}) =>
    f(base(ep) + path, { ...init, redirect: 'error', headers: { authorization: auth(ep), 'content-type': 'application/json', ...(init.headers as object) }, signal: AbortSignal.timeout(TIMEOUT) });

  return {
    kind: 'opencode',
    relayStart: 'pane-prestart',

    // Through `herdr agent start <name> --kind opencode --pane <p> -- <args>`: herdr runs the bare `opencode` executable, so the
    // freellm wrapper (folder guard) is NOT in this path; freellmRefusal() re-applies its folder rule here (read from this
    // machine's rule file at each launch unless one was injected), and the env
    // sets what the wrapper sets. The caller must supply CB_OPENCODE_PORT in `env`; the password is made in the pane by the
    // prestart (cli/agents/seat-prestart.ts secret), which writes the endpoint file on the seat's machine. A password in `env`
    // is refused: squad up passes the launch env as herdr --env arguments, visible in any process listing.
    // FREELLMAPI_URL and FREELLMAPI_API_KEY come from the pane's own env and are never copied into a LaunchSpec. The folder rule
    // applies to a freellmapi/* model and to no model at all (OpenCode then takes its config default, freellmapi/auto).
    buildLaunch(l: LaunchInput) {
      checkedEffort('opencode', l.name, l.effort); // throws on any effort: the TUI takes none
      const model = l.model ?? '';
      if (model && !OPENCODE_MODEL.test(model)) throw new Error(`opencode model must be provider/model (got ${JSON.stringify(l.model)})`);
      const cwd = normalizeAbs(l.cwd);
      if (!cwd) throw new Error(`opencode launch needs an absolute cwd (got ${JSON.stringify(l.cwd)})`);
      if (!model || model.startsWith('freellmapi/')) { const r = freellmRefusal(cwd, rule === undefined ? loadFreellmRule() : rule); if (r) throw new Error(r); }
      const env = withNoPrompt(opencodeEnv(l.env)); // PR 104 review B3: no editor or pager waits for input
      const port = Number(env.CB_OPENCODE_PORT);
      if (!validPort(port)) throw new Error('opencode launch needs env CB_OPENCODE_PORT (1024-65535)');
      if (Object.keys(env).some((k) => k.toUpperCase() === 'OPENCODE_SERVER_PASSWORD')) throw new Error('opencode launch refuses OPENCODE_SERVER_PASSWORD in its env: the launch env goes on herdr\'s argv; the pane prestart makes the password');
      return {
        kind: 'opencode',
        args: [cwd, '--hostname', '127.0.0.1', '--port', String(port), ...(model ? ['-m', model] : []), '--auto'],
        env: { ...env, OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' },
        prestart: { args: [String(port)] },
      };
    },

    // Expected (not live-checked): v1 `POST /session/<id>/prompt_async` (204, queued behind a running turn) on the newest root
    // session of `GET /session`.
    async deliver(seat: SeatHandle, text: string) {
      const ep = readEp(seat.machine, seat.pane);
      if (!ep) throw new Error('no opencode endpoint for this seat');
      const list = await call(ep, '/session');
      if (!list.ok) throw new Error(`opencode session list answered ${list.status}`);
      const id = newestSession(await list.json());
      if (!id) throw new Error('opencode has no session yet');
      const r = await call(ep, `/session/${encodeURIComponent(id)}/prompt_async`, { method: 'POST', body: JSON.stringify({ parts: [{ type: 'text', text }] }) });
      if (!r.ok) throw new Error(`opencode prompt answered ${r.status}`);
    },

    // `GET /global/health`. Alive: an HTTP answer from our server (200, or a 5xx: it is up) or a timeout (a slow machine never
    // kills a healthy relay). Dead: no endpoint file, 401/403/404 (another process on the port, or not our credential), and
    // every other network error (refused, reset, unreachable, not found).
    async isAlive(seat) {
      const ep = readEp(seat.machine, seat.pane);
      if (!ep) return false;
      try {
        const r = await call(ep, '/global/health');
        return !(r.status === 401 || r.status === 403 || r.status === 404);
      } catch (e) {
        const n = (e as any)?.name;
        return n === 'TimeoutError' || n === 'AbortError';
      }
    },

    async readStatus(_seat, herdrAgent) {
      const s = herdrAgent?.agent_status ?? '';
      const state: AgentState = STATES.has(s) ? (s as AgentState) : 'unknown';
      return { state, safeToClose: state === 'idle' || state === 'done' };
    },

    async close(seat, run) {
      if (!seat.herdrName) return 'failed';
      const r = run(seat.herdr ?? null, ['agent', 'prompt', seat.herdrName, '/exit'], 30_000);
      return r.status === 0 && !r.error ? 'sent' : 'failed';
    },

    atQuotaBanner: (paneTail) => atBannerSpot(paneTail, BANNER),

    detectQuotaStop(_seat, _herdrAgent, paneTail): QuotaSignal | null {
      if (!paneTail) return null;
      paneTail = paneTail.split(/\r?\n/).filter((l) => l.trim()).slice(-TAIL_LINES).join('\n');
      const retry = RETRY.exec(paneTail);
      const sec = retry ? Number(retry[1]) * (/^m/i.test(retry[2]!) ? 60 : 1) : undefined;
      const q = QUOTA.exec(paneTail);
      if (q) return { kind: 'quota', raw: q[0], ...(sec !== undefined ? { retryAfterSec: sec } : {}) };
      const r = RATE.exec(paneTail);
      return r ? { kind: 'rate_limit', raw: r[0], ...(sec !== undefined ? { retryAfterSec: sec } : {}) } : null;
    },

    guardInstallSpec(boardDir) {
      const t = 'bash|powershell|edit|write|patch|apply_patch|multiedit|read|grep|glob|list|question';
      return {
        targetPath: '~/.config/opencode/plugins/cb-guard.js',
        shimFile: `${boardDir.replace(/[\/\\]+$/, '')}/kit/guard/shim-opencode.mjs`,
        matchers: { win32: t, darwin: t, linux: t },
        notes: 'A plugin whose tool.execute.before runs the shim for these tools and throws Error(reason) on {"decision":"block"}; the plugin must itself throw if the shim fails',
      };
    },

    userRulesFile(home: string, env: NodeJS.ProcessEnv) {
      return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode', 'AGENTS.md');
    },

    instructionMapping() {
      return {
        nativeFiles: ['AGENTS.md', 'CLAUDE.md (project, fallback only)', '~/.config/opencode/AGENTS.md'],
        extraArgs: [],
        env: { OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1' },
        note: '~/.config/opencode/AGENTS.md exists on purpose so OpenCode never falls back to ~/.claude/CLAUDE.md (cli/agent-context.ts user copies the owner rules into it); the env flag is what the freellm wrapper sets',
      };
    },

    trustSpec() {
      return { dialogHint: 'none expected: OpenCode has no folder-trust dialog (--auto answers permission prompts)', extraArgs: [] };
    },

    disableAskSpec() {
      return { toolName: 'question', mechanism: 'permission', target: '~/.config/opencode/opencode.jsonc permission.question = "deny"' };
    },

    // #4392. OpenCode has no per-run MCP off. OPENCODE_CONFIG_CONTENT and OPENCODE_CONFIG merge into the user's config
    // ({"mcp":{}} keeps a configured server; {"mcp":{"<name>":{"enabled":false}}} needs the seat machine's names, which
    // the launch, built on the orchestrating machine, cannot know). --pure also drops the cb-guard plugin, a per-seat
    // XDG_CONFIG_HOME drops the plugin, AGENTS.md and providers, and OPENCODE_DISABLE_PROJECT_CONFIG drops the repo's
    // AGENTS.md. Checked with opencode debug config on 1.19.4 against throwaway XDG folders (not a live session).
    mcpGate: 'no enabled "mcp" entry in the OpenCode config the seat loads on its machine (~/.config/opencode/opencode.json[c], ' +
      "the repo's opencode.json[c], OPENCODE_CONFIG; check: opencode mcp list from the seat's folder lists none): " +
      'OPENCODE_CONFIG_CONTENT merges, and --pure would drop the cb-guard plugin',
    mcpOff() {
      return {
        args: [],
        env: {},
        note: 'nothing is added to the launch; MCP tools are also outside the cb-guard plugin, which forwards only its listed tools',
      };
    },
  };
}

export const opencodeAdapter: AgentAdapter = makeOpencodeAdapter();
