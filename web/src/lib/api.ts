import { useQuery } from '@tanstack/react-query'
import type { Ask } from './asks'

export type Status = 'backlog' | 'next' | 'in_progress' | 'blocked' | 'review' | 'done' | 'cancelled'

export interface Project { slug: string; name: string; color: string | null; repo_path: string | null; open_count: number; question_count: number }
export const TASK_TYPES = ['task', 'bug', 'feature', 'change', 'chore', 'research'] as const
export interface Task {
  id: number; project: string; title: string; body: string; status: Status; priority: 'P0' | 'P1' | 'P2' | 'P3'; type: (typeof TASK_TYPES)[number]
  rank: number; assignee: string | null; labels: string[]; links: Record<string, string | string[]>
  blocked_on: number | null; created_by: string; created_at: string; updated_at: string; done_at: string | null
  epic_id: number | null; epic_rank: number
  goal_rank?: number | null; goal_id?: number | null // the active goal that lifts it in Next (#663), from /api/tasks
  waits_on?: number[] // open blockers (not done or cancelled): "waits on #12"
}
/** A task as the panel lists its blockers and what it blocks. */
export type TaskRef = Pick<Task, 'id' | 'title' | 'status' | 'assignee'>
export interface Epic {
  id: number; project: string; title: string; goal: string; created_by: string; created_at: string; closed_at: string | null
  closed: boolean; status: 'open' | 'done'; total: number; done: number; cancelled: number; finished: number
}
/** Goals (#663): total = cards in, closed = done or cancelled among them, new = joined since Ahmed last opened it. */
export interface GoalRules { labels: string[]; words: string[]; epics: number[] }
export interface Goal {
  id: number; title: string; description: string; project: string | null; rules: GoalRules; status: 'active' | 'paused' | 'done'
  rank: number; created_by: string; created_at: string; closed_at: string | null; total: number; closed: number; new: number
}
export type GoalCard = Task & { state: 'in' | 'out'; via: 'match' | 'ahmed'; new: boolean; added_at: string }
export interface QOption { label: string; description: string | null }
export interface Question {
  id: number; project: string; task_id: number | null; asked_by: string; body: string; context: string | null
  options: QOption[] | null; multi: boolean; blocking: boolean; status: 'open' | 'answered' | 'delivered' | 'withdrawn' | 'dormant' | 'sent_back'
  answer: string | null; answered_at: string | null; delivered_at: string | null; delivered_to: string | null
  // a delivered answer changed (#1346): the answers the session was told before, oldest first
  answer_history?: { answer: string; answered_by: string | null; delivered_to: string | null; changed_at: string }[] | null
  reply_to: { machine?: string; pane?: string } | null; created_at: string
  assigned_to: string | null; answered_by: string | null
  ruled_by: number | null // answered "Already ruled" with this memory entry (#553)
  // follow-ups (#472): a dormant question waits for parent_id's answer (if_answer: one label, null = any)
  parent_id: number | null; if_answer: string | null; parent_answer?: string | null
  branches?: { id: number; if_answer: string | null; body: string }[] | null // this question's dormant follow-ups
  // send back (#616): while sent_back, why and by whom; versions: earlier texts, oldest first, with the send-back that asked for the rewrite
  sent_back: { reason: BackReason; note: string | null; by: string; at: string; delivered_at?: string } | null
  versions: { body: string; options: QOption[] | null; context: string | null; reason: BackReason | null; note: string | null; rewritten_at: string }[] | null
}
export type BackReason = 'details' | 'clarify' | 'simplify' | 'reask'
/** Why a question goes back to its asker: the picker's label, the quiet row's word, the rewritten card's word. */
export const BACK_REASONS: { key: BackReason; label: string; short: string; past: string }[] = [
  { key: 'details', label: 'More details', short: 'more details', past: 'more details' },
  { key: 'clarify', label: 'Ask a question', short: 'a question', past: 'clarified' },
  { key: 'simplify', label: 'Simplify', short: 'simplify', past: 'simplified' },
  { key: 'reask', label: 'Options are wrong', short: 'new options', past: 'new options' },
]
export interface User { name: string; display: string; projects?: string[] } // projects: only from /api/users, not on a guest's whoami
/** People who can take work on a project (they're on it), plus whoever already holds the item. */
export const onProject = (users: User[], project: string, holder?: string | null) =>
  users.filter((u) => u.projects?.includes(project) || u.name === holder)
export interface CbEvent {
  id: number; at: string; actor: string; project: string | null; task_id: number | null; question_id: number | null
  kind: 'task_created' | 'moved' | 'updated' | 'done' | 'note' | 'asked' | 'answered' | 'delivered' | 'withdrawn' | 'broadcast' | 'message' | 'huddle' | 'user' | 'epic' | 'memory' | 'sent_back' | 'rewritten' | 'goal' | 'ask'
  summary: string; data: Record<string, any>
}
export const MEM_KINDS = ['rule', 'ruling', 'fact', 'gotcha', 'runbook'] as const
/** Shared memory (#167). authority 'ahmed' = he added or confirmed it; 'team' = a session's note. expired = past review_after. */
export interface Memory {
  id: number; project: string | null; machine: string | null; kind: (typeof MEM_KINDS)[number]; title: string; body: string
  status: 'proposed' | 'active' | 'superseded' | 'retired'; authority: 'ahmed' | 'team'
  source: { question_id?: number; task_id?: number; supersedes?: number; flagged?: boolean }
  links: Record<string, string>; tags: string[]; created_by: string; confirmed_by: string | null; confirmed_at: string | null
  review_after: string | null; superseded_by: number | null; created_at: string; updated_at: string; expired: boolean
}

export async function get<T>(path: string): Promise<T> {
  const r = await fetch(path)
  if (!r.ok) throw new Error(`${r.status} ${path}`)
  return r.json()
}

const NO_ACTOR = new Set(['seen', 'goal_opened', 'goal_preview', 'goal_propose']) // functions without an actor argument

/** Every write goes through the same cb.* SQL functions Claude uses. The UI acts as "ahmed". */
export async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const r = await fetch(`/api/rpc/${fn}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(NO_ACTOR.has(fn) ? args : { actor: 'ahmed', ...args }),
  })
  const j = await r.json()
  if (!j.ok) throw new Error(j.error)
  return j.result
}

const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v)
  const s = p.toString()
  return s ? `?${s}` : ''
}

export const useUsers = () => useQuery({ queryKey: ['users'], queryFn: () => get<User[]>('/api/users') })
export const useProjects = () => useQuery({ queryKey: ['projects'], queryFn: () => get<Project[]>('/api/projects') })
export const useTasks = (project?: string, status?: Status) =>
  useQuery({ queryKey: ['tasks', project, status], queryFn: () => get<Task[]>(`/api/tasks${qs({ project, status })}`) })
export const useQuestions = (project?: string, status?: string) =>
  useQuery({ queryKey: ['questions', project, status], queryFn: () => get<Question[]>(`/api/questions${qs({ project, status })}`) })
export const useTask = (id: number | null) =>
  useQuery({
    queryKey: ['task', id], enabled: id != null,
    queryFn: () => get<{ task: Task; events: CbEvent[]; questions: Question[]; blockers: TaskRef[]; blocks: TaskRef[]; epic: { id: number; title: string } | null }>(`/api/tasks/${id}`),
  })
export const useEpics = (project?: string) =>
  useQuery({ queryKey: ['epics', project], queryFn: () => get<Epic[]>(`/api/epics${qs({ project })}`) })
export const useEpic = (id: number) =>
  useQuery({ queryKey: ['epic', id], queryFn: () => get<{ epic: Epic; steps: Task[] }>(`/api/epics/${id}`) })
export const useGoals = (project?: string) =>
  useQuery({ queryKey: ['goals', project], queryFn: () => get<Goal[]>(`/api/goals${qs({ project })}`) })
export const useGoal = (id: number) =>
  useQuery({ queryKey: ['goal', id], queryFn: () => get<{ goal: Goal; cards: GoalCard[] }>(`/api/goals/${id}`) })
export const useMemories = (project?: string, all?: boolean) =>
  useQuery({ queryKey: ['memories', project, !!all], queryFn: () => get<Memory[]>(`/api/memories${qs({ project, all: all ? '1' : undefined })}`) })
/** The weekly memory metric (last 7 days) and the Today card's counts (#553). stale_pct: null when nothing is live. */
export interface MemStats { proposed: number; past_review: number; live_facts: number; stale_pct: number | null; already_ruled: number; corrections: number }
export const useMemStats = (project?: string) =>
  useQuery({ queryKey: ['memories', 'stats', project], queryFn: () => get<MemStats>(`/api/memory/stats${qs({ project })}`) })
/** Live entries not past review matching words (full text, best first), for the "Already ruled" picker. */
export const useMemFind = (term: string, project?: string) =>
  useQuery({ queryKey: ['memories', 'find', project, term], enabled: term.trim().length > 1,
    queryFn: () => get<Memory[]>(`/api/memories${qs({ project, q: term.trim(), live: '1' })}`) })
/** Ahmed's asks (#936): open threads and those closed in the last day. */
export const useAsks = (project?: string) =>
  useQuery({ queryKey: ['asks', project], queryFn: () => get<Ask[]>(`/api/asks${qs({ project })}`) })
export { qs }
