import { useQuery } from '@tanstack/react-query'

export type Status = 'backlog' | 'next' | 'in_progress' | 'blocked' | 'review' | 'done' | 'cancelled'

export interface Project { slug: string; name: string; color: string | null; repo_path: string | null; open_count: number; question_count: number }
export const TASK_TYPES = ['task', 'bug', 'feature', 'change', 'chore', 'research'] as const
export interface Task {
  id: number; project: string; title: string; body: string; status: Status; priority: 'P0' | 'P1' | 'P2' | 'P3'; type: (typeof TASK_TYPES)[number]
  rank: number; assignee: string | null; labels: string[]; links: Record<string, string | string[]>
  blocked_on: number | null; created_by: string; created_at: string; updated_at: string; done_at: string | null
}
export interface QOption { label: string; description: string | null }
export interface Question {
  id: number; project: string; task_id: number | null; asked_by: string; body: string; context: string | null
  options: QOption[] | null; multi: boolean; blocking: boolean; status: 'open' | 'answered' | 'delivered' | 'withdrawn'
  answer: string | null; answered_at: string | null; delivered_at: string | null; delivered_to: string | null
  reply_to: { machine?: string; pane?: string } | null; created_at: string
}
export interface CbEvent {
  id: number; at: string; actor: string; project: string | null; task_id: number | null; question_id: number | null
  kind: 'task_created' | 'moved' | 'updated' | 'done' | 'note' | 'asked' | 'answered' | 'delivered' | 'withdrawn' | 'broadcast' | 'message' | 'huddle'
  summary: string; data: Record<string, any>
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

export const useProjects = () => useQuery({ queryKey: ['projects'], queryFn: () => get<Project[]>('/api/projects') })
export const useTasks = (project?: string, status?: Status) =>
  useQuery({ queryKey: ['tasks', project, status], queryFn: () => get<Task[]>(`/api/tasks${qs({ project, status })}`) })
export const useQuestions = (project?: string, status?: string) =>
  useQuery({ queryKey: ['questions', project, status], queryFn: () => get<Question[]>(`/api/questions${qs({ project, status })}`) })
export const useTask = (id: number | null) =>
  useQuery({
    queryKey: ['task', id], enabled: id != null,
    queryFn: () => get<{ task: Task; events: CbEvent[]; questions: Question[] }>(`/api/tasks/${id}`),
  })
export { qs }
