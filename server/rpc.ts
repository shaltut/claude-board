// POST /api/rpc/<fn> → select cb.<fn>(name => $1, ...). Whitelisted; same SQL the CLI and psql use.
import { sql } from './db.ts';

export const RPC_FUNCTIONS = [
  'task_add', 'task_move', 'task_update', 'task_done', 'log', 'task_claim', 'mine',
  'ask', 'answer', 'send_back', 'reask', 'withdraw', 'answers_pending', 'answer_delivered', 'brief', 'seen', 'iam', 'inbox', 'broadcast', 'task_tag', 'sessions_overview', 'tell', 'type_to', 'task_ping_set', 'task_ping_bulk', 'huddle_open', 'huddle_add', 'huddle_say', 'huddle_close', 'huddles_list', 'user_add', 'user_rotate', 'user_remove', 'user_project_add', 'user_project_remove', 'user_password', 'user_set_role', 'question_assign',
  'tick', 'lock_take', 'lock_release', 'lock_queue',
  'epic_create', 'epic_update', 'epic_close', 'epic_delete', 'epics_list', 'task_block', 'task_unblock',
  'mem_add', 'mem_rule', 'mem_confirm', 'mem_retire', 'mem_supersede', 'mem_find', 'mem_list', 'mem_show', 'mem_pack', 'task_find',
  'goal_create', 'goal_update', 'goal_status', 'goal_tick', 'goal_opened', 'goal_preview', 'goal_propose', 'goals_list',
  'ask_open', 'ask_record', 'ask_say', 'ask_reply', 'ask_close', 'ask_reroute', 'asks_list',
  'page_set', 'page_get', 'stage_set', 'stage_pass', 'stage_fail', 'digest', 'resume', 'next_step', 'task_queue', 'project_pipeline', 'project_auto_backup', 'role_text', 'squad_set', 'squad_get',
  // the project settings page (#4332); the github_* writes are cb github's too
  'squad_options', 'squad_page', 'role_text_set', 'role_text_page', 'github_watch_add', 'github_watch_remove', 'github_mute', 'github_watches',
  // the Runners page (#4527): Ahmed only from the web (server/main.ts QUEUE_OWNER); the read is GET /api/runners
  'job_cancel', 'job_retry', 'job_move', 'job_hold', 'runner_set', 'runner_limits_set',
  // one project's addition and who its seats ask first; loading the release's role texts (#4525)
  'project_role_set', 'project_role_page', 'role_text_import',
  // project states (#4559): the change is Ahmed's (OWNER_ONLY in server/main.ts); the preview is the confirm dialog's read
  'project_state', 'project_state_preview',
];
const SETOF = new Set(['task_claim', 'mine', 'answers_pending', 'task_queue']);

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

/** cb's queries go through its session's relay when it has one (cli/bridge.ts): callFn's default follows. */
let fallback: any = sql;
export const useDb = (db: any) => { fallback = db; };

export async function callFn(fn: string, args: Record<string, unknown> = {}, db: any = fallback) {
  if (!RPC_FUNCTIONS.includes(fn)) throw new RpcError(404, `unknown function ${fn}; available: ${RPC_FUNCTIONS.join(', ')}`);
  const keys = Object.keys(args);
  for (const k of keys) if (!/^[a-z_]+$/.test(k)) throw new RpcError(400, `bad argument name "${k}"`);
  const ps = keys.map((k, i) => param(i + 1, args[k]));
  const call = keys.map((k, i) => `${k} => ${ps[i].expr}`).join(', ');
  const values = ps.map((p) => p.value) as any[];
  if (SETOF.has(fn)) return await db.unsafe(`select * from cb.${fn}(${call})`, values);
  const [row] = await db.unsafe(`select cb.${fn}(${call}) as result`, values);
  return row?.result ?? null;
}
