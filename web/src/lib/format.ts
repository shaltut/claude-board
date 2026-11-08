import type { Status } from './api'

export const STATUS: Record<Status, { label: string; color: string }> = {
  backlog: { label: 'Backlog', color: 'var(--st-backlog)' },
  next: { label: 'Next', color: 'var(--st-next)' },
  in_progress: { label: 'In progress', color: 'var(--st-progress)' },
  blocked: { label: 'Blocked', color: 'var(--st-blocked)' },
  review: { label: 'Review', color: 'var(--st-review)' },
  done: { label: 'Done', color: 'var(--st-done)' },
  cancelled: { label: 'Cancelled', color: 'var(--st-backlog)' },
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  const d = Math.round(s / 86400)
  return d === 1 ? 'yesterday' : `${d}d ago`
}

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

export const day = (iso: string) => {
  const d = new Date(iso)
  const today = new Date()
  const y = new Date(); y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
}

/** "W2@macbook" → { who: "W2", where: "macbook" } */
export function splitActor(a: string) {
  const i = a.indexOf('@')
  return i > 0 ? { who: a.slice(0, i), where: a.slice(i + 1) } : { who: a, where: '' }
}
