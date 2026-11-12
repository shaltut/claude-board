// POST /api/rpc/<fn> → select cb.<fn>(name => $1, ...). Whitelisted; same SQL the CLI and psql use.
import { sql } from './db.ts';

export const RPC_FUNCTIONS = [
  'task_add', 'task_move', 'task_update', 'task_done', 'log', 'task_claim', 'mine',
  'ask', 'answer', 'send_back', 'reask', 'withdraw', 'answers_pending', 'answer_delivered', 'brief', 'seen', 'iam', 'inbox', 'broadcast', 'task_tag', 'sessions_overview', 'tell', 'huddle_open', 'huddle_add', 'huddle_say', 'huddle_close', 'huddles_list', 'user_add', 'user_rotate', 'user_remove', 'user_project_add', 'user_project_remove', 'user_password', 'user_set_role', 'question_assign',
  'tick', 'lock_take', 'lock_release', 'lock_queue',
  'epic_create', 'epic_update', 'epic_close', 'epic_delete', 'epics_list', 'task_block', 'task_unblock',
  'mem_add', 'mem_rule', 'mem_confirm', 'mem_retire', 'mem_supersede', 'mem_find', 'mem_list', 'mem_show', 'mem_pack',
  'goal_create', 'goal_update', 'goal_status', 'goal_tick', 'goal_opened', 'goal_preview', 'goal_propose', 'goals_list',
  'ask_open', 'ask_record', 'ask_say', 'ask_reply', 'ask_close', 'ask_reroute', 'asks_list',
];
// The cb CLI's reads, and the GitHub watch's writes: direct transport only (Ahmed's machines). Never served by
// /api/rpc. A read here takes `scope` (see db/schema.sql, "reads for the CLI") or is knowingly scope-free
// (test/reads.test.ts lists those).
export const CLI_FUNCTIONS = [
  'session_at', 'session_of', 'session_show', 'task_peek', 'task_show', 'projects_summary', 'queue_head', 'questions_asked',
  'released', 'user_get', 'users_overview', 'huddle_show', 'question_peek', 'question_parents',
  'github_list', 'github_watch', 'github_unwatch', 'github_mute', 'read_project', 'resolve',
];
const CLI_ALLOWED = [...RPC_FUNCTIONS, ...CLI_FUNCTIONS];
const SETOF = new Set(['task_claim', 'mine', 'answers_pending']);

export class RpcError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Arrays and objects go as jsonb (every cb.* array/object param is jsonb); the rest as text Postgres coerces. */
function param(i: number, v: unknown): { expr: string; value: unknown } {
  const n = `$${i}`;
  if (v === null || v === undefined) return { expr: n, value: null };
  if (typeof v === 'object') return { expr: `${n}::jsonb`, value: v };
  return { expr: n, value: typeof v === "boolean" ? v : String(v) }; // postgres.js serializes booleans by identity
}

export async function callFn(fn: string, args: Record<string, unknown> = {}, db: any = sql, allowed: string[] = RPC_FUNCTIONS) {
  if (!allowed.includes(fn)) throw new RpcError(404, `unknown function ${fn}; available: ${RPC_FUNCTIONS.join(', ')}`);
  const keys = Object.keys(args);
  for (const k of keys) if (!/^[a-z_]+$/.test(k)) throw new RpcError(400, `bad argument name "${k}"`);
  const ps = keys.map((k, i) => param(i + 1, args[k]));
  const call = keys.map((k, i) => `${k} => ${ps[i].expr}`).join(', ');
  const values = ps.map((p) => p.value) as any[];
  if (SETOF.has(fn)) return await db.unsafe(`select * from cb.${fn}(${call})`, values);
  const [row] = await db.unsafe(`select cb.${fn}(${call}) as result`, values);
  return row?.result ?? null;
}

/** What the CLI calls: everything /api/rpc serves, plus its own reads. */
export const callCli = (fn: string, args: Record<string, unknown> = {}) => callFn(fn, args, sql, CLI_ALLOWED);
