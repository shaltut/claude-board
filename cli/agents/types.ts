// The contract every agent CLI (Claude, Codex, OpenCode, Antigravity) meets. Pure types: no runtime code.
import type { Runner } from '../squad-up.ts';

export type { Runner };
export type AgentKind = 'claude' | 'codex' | 'opencode' | 'agy';
export type AgentState = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
export type SeatHandle = { machine: string; pane: string; actor?: string; herdr?: string | null; herdrName?: string; agent: AgentKind };
/** `args` are what follows `--` in `herdr agent start <name> --kind <kind> --pane <pane> -- <args>`. */
/** `prestart` (#4002): run kit/seat/prestart.{sh,ps1} in the pane before the agent starts; squad up adds board, agent,
 *  machine and pane, then these plain words. It strips the Claude-only env from the pane's real shell and checks the guard
 *  will run; the seat is refused unless it prints cb-seat-ready. Absent (Claude): the launch is exactly as before. */
export type LaunchSpec = { kind: string; args: string[]; env: Record<string, string>; prestart?: { args: string[] } };
export type AgentStatus = { state: AgentState; safeToClose: boolean; detail?: string };
export type QuotaSignal = { kind: 'quota' | 'rate_limit'; retryAfterSec?: number; raw: string };
export type GuardInstallSpec = { targetPath: string; shimFile: string; matchers: Record<'win32' | 'darwin' | 'linux', string>; notes: string };
export type InstructionMapping = { nativeFiles: string[]; extraArgs: string[]; env: Record<string, string>; note: string };
/** preseed (#4575): how cb squad trust marks a folder trusted in the agent's own config, so its folder-trust dialog never
 *  shows. file: under the home folder, '/'-separated. state and add are pure over the file's text; add throws a path the
 *  file cannot hold. 'untrusted': the owner said no for that folder, which is left alone. 'other': the folder is set
 *  by hand in a form add does not write, also left alone. Absent preseed: no dialog to preseed. */
export type TrustPreseed = { file: string; state(text: string, path: string): 'trusted' | 'untrusted' | 'other' | 'absent'; add(text: string, path: string): string };
export type TrustSpec = { dialogHint: string; preseedPath?: string; preseed?: TrustPreseed; extraArgs: string[] };
export type DisableAskSpec = { toolName: string; mechanism: 'hook' | 'permission'; target: string };
/** How a seat starts with no MCP server (#4392): `args` and `env` for this run only (buildLaunch adds them; never the
 *  user's own config). What they cannot turn off is the adapter's `mcpGate`. */
export type McpOffSpec = { args: string[]; env: Record<string, string>; note: string };
export type LaunchInput = { name: string; role: string; area?: string; repo: string; agent: AgentKind; model: string; effort?: string; board: string; cwd: string; env?: Record<string, string> };

export interface AgentAdapter {
  readonly kind: AgentKind;
  readonly relayStart: 'session-hook' | 'pane-prestart';
  buildLaunch(launch: LaunchInput): LaunchSpec;
  deliver(seat: SeatHandle, text: string, opts?: { raw?: boolean }): Promise<void>;
  /** The text as this agent's input box must receive it to submit (#4002: Codex opens a popup on a trailing $word or
   *  @word and Enter picks from it). deliver and squad up's first prompt both use it. Absent: the text as given. */
  promptText?(text: string): string;
  isAlive(seat: SeatHandle): Promise<boolean>;
  /** The agent session serving the seat now (#4379), handed to cb.inbox: another id than the pane's row has means a new
   *  session in a reused pane, and the row starts again. Optional: an agent without one keeps the row as it is. */
  sessionId?(seat: SeatHandle): string | null;
  readStatus(seat: SeatHandle, herdrAgent: { agent_status?: string } | null): Promise<AgentStatus>;
  close(seat: SeatHandle, run: Runner): Promise<'sent' | 'failed'>;
  detectQuotaStop(seat: SeatHandle, herdrAgent: { agent_status?: string } | null, paneTail?: string): QuotaSignal | null;
  /** #4787: whether the quota words stand where this CLI prints its own limit message (cli/agents/screen.ts). Only then
   *  may the supervisor switch the seat to a backup. */
  atQuotaBanner(paneTail: string): boolean;
  /** #4786: the model the agent's own screen says it runs now, as a model id; null: the screen does not say. Absent: not
   *  read from the screen (Claude's comes from its usage hook; the others report none yet). */
  runningModel?(screen: string): string | null;
  guardInstallSpec(boardDir: string, platform: NodeJS.Platform): GuardInstallSpec;
  instructionMapping(launch: LaunchInput): InstructionMapping;
  /** #4765: the user-level rules file this agent reads on this machine, for cli/agent-context.ts to copy the owner's
   *  rules into. Null: it reads the source (Claude Code's user file) itself. */
  userRulesFile(home: string, env: NodeJS.ProcessEnv): string | null;
  trustSpec(repoPaths: string[], platform: NodeJS.Platform): TrustSpec;
  disableAskSpec(): DisableAskSpec;
  mcpOff(board: string): McpOffSpec;
  /** Null when mcpOff turns every MCP source off. Otherwise what the CLI cannot turn off per run, which must hold on every
   *  machine that runs this agent's seats: getAdapter refuses the agent until CB_MCP_GATE_OK names it (#4392). */
  readonly mcpGate: string | null;
}
