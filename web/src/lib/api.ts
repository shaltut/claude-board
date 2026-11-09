import { useQuery } from '@tanstack/react-query'

export type Status = 'backlog' | 'next' | 'in_progress' | 'blocked' | 'review' | 'done' | 'cancelled'

export interface Project { slug: string; name: string; color: string | null; repo_path: string | null; open_count: number; question_count: number }
export const TASK_TYPES = ['task', 'bug', 'feature', 'change', 'chore', 'research'] as const
export interface Task {
  id: number; project: string; title: string; body: string; status: Status; priority: 'P0' | 'P1' | 'P2' | 'P3'; type: (typeof TASK_TYPES)[number]
  rank: number; assignee: string | null; labels: string[]; links: Record<string, string | string[]>
  blocked_on: number | null; created_by: string; created_at: string; updated_at: string; done_at: string | null
  epic_id: number | null; epic_rank: number
  waits_on?: number[] // open blockers (not done or cancelled): "waits on #12"
}
/** A task as the panel lists its blockers and what it blocks. */
export type TaskRef = Pick<Task, 'id' | 'title' | 'status' | 'assignee'>
export interface Epic {
  id: number; project: string; title: string; goal: string; created_by: string; created_at: string; closed_at: string | null
  closed: boolean; status: 'open' | 'done'; total: number; done: number; cancelled: number; finished: number
}
export interface QOption { label: string; description: string | null }
export interface Question {
  id: number; project: string; task_id: number | null; asked_by: string; body: string; context: string | null
  options: QOption[] | null; multi: boolean; blocking: boolean; status: 'open' | 'answered' | 'delivered' | 'withdrawn' | 'dormant'
  answer: string | null; answered_at: string | null; delivered_at: string | null; delivered_to: string | null
  reply_to: { machine?: string; pane?: string } | null; created_at: string
  assigned_to: string | null; answered_by: string | null
  ruled_by: number | null // answered "Already ruled" with this memory entry (#553)
  // follow-ups (#472): a dormant question waits for parent_id's answer (if_answer: one label, null = any)
  parent_id: number | null; if_answer: string | null; parent_answer?: string | null
  branches?: { id: number; if_answer: string | null; body: string }[] | null // this question's dormant follow-ups
}
export interface User { name: string; display: string; projects?: string[] } // projects: only from /api/users, not on a guest's whoami
/** People who can take work on a project (they're on it), plus whoever already holds the item. */
export const onProject = (users: User[], project: string, holder?: string | null) =>
  users.filter((u) => u.projects?.includes(project) || u.name === holder)
export interface CbEvent {
  id: number; at: string; actor: string; project: string | null; task_id: number | null; question_id: number | null
  kind: 'task_created' | 'moved' | 'updated' | 'done' | 'note' | 'asked' | 'answered' | 'delivered' | 'withdrawn' | 'broadcast' | 'message' | 'huddle' | 'user' | 'epic' | 'memory'
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

/** Every write goes through the same cb.* SQL functions Claude uses. The UI acts as "ahmed". */
export async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const r = await fetch(`/api/rpc/${fn}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(fn === 'seen' ? args : { actor: 'ahmed', ...args }),
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
export { qs }
