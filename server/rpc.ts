// POST /api/rpc/<fn> → select cb.<fn>(name => $1, ...). Whitelisted; same SQL the CLI and psql use.
import { sql } from './db.ts';

export const RPC_FUNCTIONS = [
  'task_add', 'task_move', 'task_update', 'task_done', 'log', 'task_claim', 'mine',
  'ask', 'answer', 'send_back', 'reask', 'withdraw', 'answers_pending', 'answer_delivered', 'brief', 'seen', 'iam', 'inbox', 'broadcast', 'task_tag', 'sessions_overview', 'tell', 'huddle_open', 'huddle_add', 'huddle_say', 'huddle_close', 'huddles_list', 'user_add', 'user_rotate', 'user_remove', 'user_project_add', 'user_project_remove', 'user_password', 'question_assign',
  'tick', 'lock_take', 'lock_release', 'lock_queue',
  'epic_create', 'epic_update', 'epic_close', 'epic_delete', 'epics_list', 'task_block', 'task_unblock',
  'mem_add', 'mem_rule', 'mem_confirm', 'mem_retire', 'mem_supersede', 'mem_find', 'mem_list', 'mem_show', 'mem_pack',
];
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

export async function callFn(fn: string, args: Record<string, unknown> = {}, db: any = sql) {
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
