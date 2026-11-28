// The OpenAI Codex CLI adapter (#4002 phase 2). Pure: no database. Codex has no inbox socket, so delivery and liveness go
// through herdr (`herdr agent prompt` / `herdr agent get`), and the board's relay is started by the pane, not a session hook.
// Every flag below was read from `codex --help` and the installed binary (see docs/superpowers/specs/2026-11-26-codex-adapter-design.md).
// Message text is never logged or put in an error message.
import { classifyAgentGet, realRun } from '../squad-up.ts';
import type { Runner } from '../squad-up.ts';
import { HANDLED_TOOLS } from '../../kit/guard/shim-codex.mjs';
import type { AgentAdapter, AgentState, LaunchInput, QuotaSignal } from './types.ts';
import { atBannerSpot } from './screen.ts';
import { stripClaudeOnly, withNoPrompt } from './env.ts';
import { codexPreseed } from './trust.ts';
import { join } from 'node:path';
import { checkedEffort } from './effort.ts';

/** Never a Claude model name: spec section 3 (catches a copy-paste when `agent` changes but `model` does not). */
export const CLAUDE_MODEL_NAMES = ['opus', 'sonnet', 'haiku', 'fable'] as const;
const MODEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** The model problem, or null. An empty model means the squad names none: Codex then uses its own configured default. */
export function codexModelProblem(model: string): string | null {
  if (model === '') return null;
  if ((CLAUDE_MODEL_NAMES as readonly string[]).includes(model.toLowerCase())) return `"${model}" is a Claude model name, not a Codex one`;
  return MODEL.test(model) ? null : `"${model}" is not a Codex model name (letters, digits, dot, dash, underscore; at most 64)`;
}

/** The Claude-only names (cli/agents/env.ts) as a glob list for Codex's own `shell_environment_policy.exclude`: a second
 *  line behind the pane prestart, which drops them from the pane's shell before Codex starts. TOML literal strings, so
 *  there are no double quotes for a shell to lose. */
const EXCLUDE = "shell_environment_policy.exclude=['GITHUB_PERSONAL_ACCESS_TOKEN','CLAUDE_CODE_*','ANTHROPIC_*','CLAUDECODE']";

const STATES = new Set<string>(['idle', 'working', 'blocked', 'done']);
// Real strings in the 0.166 binary (the apostrophe is the typographic one): "You’ve hit your usage limit. Upgrade to Pro ...",
// "Your workspace is out of credits.", and the model switch notice "Automatically switched to <model> due to usage limits."
const QUOTA = /You[’']ve hit your usage limit[^\n]*|Your workspace is out of credits[^\n]*|You hit your spend cap[^\n]*/i;
const RATE = /exceeded retry limit, last status: 429|Automatically switched to [^\n]* due to usage limits/i;
// #4787: the limit message as the CLI prints it: behind its error mark, or at the first column (indented with no mark
// is a wrapped line of the agent's own answer)
const BANNER = /^(?:[ \t]*■[ \t]*)?(?:You[’']ve hit your usage limit|Your workspace is out of credits|You hit your spend cap)/i;
const RETRY_IN = /try again in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m)\b\s*,?\s*(?:and\s+)?)+)/i;
const UNIT_SEC: Record<string, number> = { d: 86400, h: 3600, m: 60 };
/** #4002: Codex opens its skill ($) or mention (@) popup while the last word starts with one, and the Enter that submits
 *  then picks from the popup: the message sits unsent while herdr reports it sent. A trailing space ends the word first.
 *  Trailing whitespace is trimmed before the test: a final newline would otherwise hide the word from `$`. */
export const codexPromptText = (text: string) => { const t = text.replace(/\s+$/, ''); return /(?:^|\s)[$@]\S*$/.test(t) ? `${t} ` : text; };

/** "try again in 2 hours 5 minutes" in seconds; undefined when the text names a clock time or nothing. */
function retryAfterSec(text: string): number | undefined {
  const m = RETRY_IN.exec(text);
  if (!m) return undefined;
  let total = 0;
  for (const [, n, u] of m[1]!.matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/gi)) total += Number(n) * (UNIT_SEC[u!.charAt(0).toLowerCase()] ?? 0);
  return total > 0 ? total : undefined;
}

// realRun is read when a call is made, never at import: squad-up.ts imports the registry that imports this file.
export function createCodexAdapter(run: Runner = (m, a, t) => realRun(m, a, t)): AgentAdapter {
  const adapter: AgentAdapter = {
    kind: 'codex',
    // No SessionStart hook hands the relay anything: the seat's relay is started by the pane before the agent runs.
    relayStart: 'pane-prestart',

    // `herdr agent start <name> --kind codex --pane <pane> -- <args>`. `--no-daemon` comes first, right after the program name.
    buildLaunch(l: LaunchInput) {
      const bad = codexModelProblem(l.model);
      if (bad) throw new Error(`codex seat ${l.name}: ${bad}`);
      const effort = checkedEffort('codex', l.name, l.effort);
      const env = withNoPrompt(stripClaudeOnly(l.env));
      return {
        kind: 'codex',
        args: [
          '--no-daemon', // without it Codex joins the shared daemon, and the daemon's env (not the pane's) would reach the seat
          ...(l.model ? ['-m', l.model] : []),
          ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []),
          '-a', 'never', // never ask a person: a failed command goes back to the model; the guard hook is the fence
          // #4002 install gate (Ahmed, Q3004): Codex runs hooks only once a person trusts them, and Esc on "Hooks need
          // review" goes on without them (the guard fails open). With this flag the installed hooks always run; the
          // prestart refuses a seat whose hooks.json has no cb guard entry, and the fence keeps every seat out of hooks.json
          // and config.toml. DANGEROUS in Codex's help: a trusted project's own .codex hooks run unreviewed too.
          '--dangerously-bypass-hook-trust',
          // Q3023 (Ahmed, 27 Nov): a seat runs like a Claude seat, no CLI sandbox, the board guard is the fence. Every role,
          // read-only ones too (#4611): Codex's read-only sandbox has no node and no network on the PC (#4573), so cb iam
          // failed and the seat never bound. A reviewer, qa or investigator seat is fenced as a Claude one is: the guard's
          // read-only role rules block its apply_patch, Edit and Write, commits and pushes
          '-s', 'danger-full-access',
          // PR 104 review B3: exec_command runs without a terminal, so an editor, pager or prompt that wants one fails
          // instead of waiting for write_stdin, which no hook sees (#4626). An unknown feature name is a startup error
          '--disable', 'unified_exec_tty',
          '-c', EXCLUDE,
          ...adapter.mcpOff(l.board).args,
          ...adapter.trustSpec([l.cwd], process.platform).extraArgs,
          ...adapter.instructionMapping(l).extraArgs,
        ],
        env,
        prestart: { args: [] },
      };
    },

    promptText: codexPromptText,

    // herdr types the text and submits it; it refuses with agent_blocked before sending a byte while a dialog is open, and a
    // busy turn takes it as a steer. Any failure throws, so the relay does not advance and the message retries.
    async deliver(seat, text) {
      if (!seat.herdrName) throw new Error('no herdr name for this codex seat');
      const r = run(seat.herdr ?? null, ['agent', 'prompt', seat.herdrName, codexPromptText(text)], 15_000);
      if (r.error || r.status !== 0) throw new Error(`herdr agent prompt failed (exit ${r.status}): ${String(r.error?.message ?? r.stderr ?? '').replace(/\s+/g, ' ').slice(0, 120)}`);
    },

    // The pane's agent is the only liveness signal Codex gives. Unknown outcomes count as alive (as for Claude), so a
    // slow herdr never kills a healthy relay; only agent_not_found is dead.
    async isAlive(seat) {
      if (!seat.herdrName) return false;
      return classifyAgentGet(run(seat.herdr ?? null, ['agent', 'get', seat.herdrName], 10_000)) !== 'absent';
    },

    // herdr 0.9.5 reads Codex's terminal title for the state. A startup dialog (update, hooks review, trust) reads as blocked.
    async readStatus(_seat, herdrAgent) {
      const s = herdrAgent?.agent_status ?? '';
      const state: AgentState = STATES.has(s) ? (s as AgentState) : 'unknown';
      return { state, safeToClose: state === 'idle' || state === 'done' };
    },

    // `/exit` is a Codex slash command ("Exit Codex" in the binary). A busy turn queues it, so the supervisor checks
    // safeToClose first, as for Claude.
    async close(seat, runner) {
      if (!seat.herdrName) return 'failed';
      const r = runner(seat.herdr ?? null, ['agent', 'prompt', seat.herdrName, '/exit'], 30_000);
      return r.status === 0 && !r.error ? 'sent' : 'failed';
    },

    atQuotaBanner: (paneTail) => atBannerSpot(paneTail, BANNER),

    detectQuotaStop(_seat, _herdrAgent, paneTail): QuotaSignal | null {
      if (!paneTail) return null;
      const q = QUOTA.exec(paneTail);
      if (q) return { kind: 'quota', raw: q[0].trim(), retryAfterSec: retryAfterSec(q[0]) };
      const r = RATE.exec(paneTail);
      return r ? { kind: 'rate_limit', raw: r[0].trim() } : null;
    },

    // The matcher decides whether the hook runs at all: a tool it does not name is never guarded (fail open). #4609: a
    // catch-all, so a tool Codex adds later still reaches the shim. In a board seat the shim denies every tool it does not
    // judge (HANDLED_TOOLS); outside one the hook is machine-wide, so Codex gets exactly what Claude gets there: those tools
    // pass and shell commands get the dangerous-command rules only (PR 96 review I3, r2 ruling). Codex 0.160's exec_command arrives as Bash, and write_stdin fires no hook (#4618, #4626).
    // node kit/guard/install.mjs --agents codex writes this entry, pointing at the installed shim (AGENT_MATCHERS there).
    guardInstallSpec(boardDir) {
      return {
        targetPath: '~/.codex/hooks.json',
        shimFile: `${boardDir.replace(/[\/\\]+$/, '')}/kit/guard/shim-codex.mjs`,
        matchers: { win32: '.*', darwin: '.*', linux: '.*' },
        notes: "PreToolUse entry in ~/.codex/hooks.json beside herdr's SessionStart entry (never edit that one); the installer sets [features] hooks = true in config.toml. A tool the matcher does not name is never guarded. A changed hooks.json would make Codex show \"Hooks need review\"; board seats launch with --dangerously-bypass-hook-trust (Q3004), so the installed hooks run without it, and the seat prestart refuses a seat whose hooks.json lacks this entry.",
      };
    },

    userRulesFile(home: string, env: NodeJS.ProcessEnv) {
      return join(env.CODEX_HOME || join(home, '.codex'), 'AGENTS.md');
    },

    // Codex reads AGENTS.md natively (the closest one to the cwd wins); CLAUDE.md is the fallback where a folder has no AGENTS.md.
    instructionMapping() {
      return {
        nativeFiles: ['AGENTS.md', '~/.codex/AGENTS.md'],
        extraArgs: ['-c', "project_doc_fallback_filenames=['CLAUDE.md']"],
        env: {},
        note: 'AGENTS.md first, CLAUDE.md as the fallback filename; the user-level file is ~/.codex/AGENTS.md (a CLAUDE.md in the home folder is not read)',
      };
    },

    // Startup dialogs on 0.160+: "Update available" is pre-empted by the -c flag; "Hooks need review" by the launch's
    // --dangerously-bypass-hook-trust (Q3004). A folder not under [projects] still shows the folder trust dialog: the seat
    // parks as agent_not_ready until a person answers it; the board never does. cb squad trust (#4575), run once by Ahmed,
    // writes that [projects] entry for the squad's folders (preseed), and squad up stops a seat whose folder lacks it.
    trustSpec(_paths, platform) {
      return {
        dialogHint: '"Update available" (the launch already turns the update check off); the folder trust dialog for a folder not under [projects] in ~/.codex/config.toml (hook trust is bypassed: the launch runs the installed hooks)',
        preseedPath: '~/.codex/config.toml',
        preseed: codexPreseed(platform),
        extraArgs: ['-c', 'check_for_update_on_startup=false'],
      };
    },

    disableAskSpec() {
      return { toolName: 'request_user_input', mechanism: 'hook', target: 'kit/guard/shim-codex.mjs' };
    },

    // #4392. Codex gets MCP servers from three places. Plugins (a plugin bundles servers) and apps (connectors, served as
    // MCP) are features: --disable turns them off for this run, and an unknown feature name is a startup error, so a
    // rename fails loudly. skill_mcp_dependency_install would offer to add a skill's servers to config.toml. The third,
    // [mcp_servers] in ~/.codex/config.toml (or a trusted repo's .codex/config.toml), has no per-run off: -c merges into
    // the table (-c mcp_servers={} keeps a configured server), only -c mcp_servers.<name>.enabled=false turns one off,
    // and a name not in the config is a config error; the launch is built on the orchestrating machine, so it cannot
    // know the seat machine's names. --ignore-user-config exists on `codex exec` only, and a per-seat CODEX_HOME would
    // lose the login and the guard's hooks.json. Checked with codex mcp list on 0.160 against a throwaway CODEX_HOME
    // (not a live session).
    mcpGate: "no enabled [mcp_servers] entry in ~/.codex/config.toml or the repo's .codex/config.toml on the seat's machine " +
      "(check: codex mcp list --disable plugins --disable apps, from the seat's folder, lists none): Codex has no per-run " +
      'way to drop them, -c merges into that table',
    mcpOff() {
      return {
        args: ['--disable', 'plugins', '--disable', 'apps', '--disable', 'skill_mcp_dependency_install'],
        env: {},
        note: 'plugin, connector (apps) and skill-install MCP are off for the run; servers in config.toml are the install gate',
      };
    },
  };
  return adapter;
}

export const codexAdapter: AgentAdapter = createCodexAdapter();
