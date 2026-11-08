import { CheckCircle2, CircleDot, HelpCircle, MessageSquareReply, PencilLine, Plus, Send, StickyNote, XCircle, Megaphone } from 'lucide-react'
import type { CbEvent, Status } from '@/lib/api'
import { clock, day, STATUS } from '@/lib/format'
import { go } from '@/lib/route'
import { cn } from '@/lib/utils'
import { ActorChip, ProjectDot, StatusDot, TaskId } from './Chips'

const ICON: Record<CbEvent['kind'], typeof Plus> = {
  task_created: Plus, moved: CircleDot, updated: PencilLine, done: CheckCircle2, note: StickyNote,
  asked: HelpCircle, answered: MessageSquareReply, delivered: Send, withdrawn: XCircle, broadcast: Megaphone,
}

/** The DB's default move summary is "next → in_progress"; show it with the board's labels. */
function prettySummary(e: CbEvent) {
  const m = e.summary.match(/^(\w+) → (\w+)$/)
  const a = m && STATUS[m[1] as Status], b = m && STATUS[m[2] as Status]
  return a && b ? `${a.label} → ${b.label}` : e.summary
}

export function EventRow({ e, showProject, dense }: { e: CbEvent; showProject?: boolean; dense?: boolean }) {
  const Icon = ICON[e.kind] ?? StickyNote // a kind the UI doesn't know yet must not blank the page
  const to = e.data?.to as Status | undefined
  const links = (e.data?.links ?? {}) as Record<string, string>
  return (
    <li className={cn('grid grid-cols-[3rem_1fr] gap-3', dense ? 'py-1.5' : 'py-2')}>
      <time dateTime={e.at} className="pt-0.5 font-mono text-xs text-muted-foreground">{clock(e.at)}</time>
      <div className="min-w-0 text-sm">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <ActorChip actor={e.actor} />
          <Icon className={cn('size-3.5 shrink-0', e.kind === 'done' ? 'text-st-done' : e.kind === 'asked' ? 'text-dawn' : 'text-muted-foreground')} aria-label={e.kind} />
          {e.kind === 'moved' && to && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><StatusDot status={to} />{STATUS[to]?.label}</span>}
          {e.task_id && <button onClick={() => go({ task: e.task_id! })} className="hover:underline"><TaskId id={e.task_id} /></button>}
          {e.question_id && <span className="font-mono text-xs text-dawn">Q{e.question_id}</span>}
          {showProject && e.project && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><ProjectDot slug={e.project} />{e.project}</span>}
        </div>
        <p className="mt-0.5 text-pretty text-foreground/90">{prettySummary(e)}</p>
        {Object.keys(links).length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {Object.entries(links).map(([k, v]) => (
              <span key={k} className="rounded bg-raised px-1.5 py-px font-mono text-[11px] text-muted-foreground">{k} {String(v)}</span>
            ))}
          </div>
        )}
      </div>
    </li>
  )
}

/** Events grouped by day, then by hour, newest first. */
export function Timeline({ events, showProject }: { events: CbEvent[]; showProject?: boolean }) {
  const groups: { label: string; items: CbEvent[] }[] = []
  for (const e of events) {
    const d = new Date(e.at)
    const label = `${day(e.at)}, ${String(d.getHours()).padStart(2, '0')}:00`
    const last = groups.at(-1)
    if (last?.label === label) last.items.push(e)
    else groups.push({ label, items: [e] })
  }
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <section key={g.label}>
          <h3 className="sticky top-14 z-10 bg-background/95 py-1 text-xs font-medium text-muted-foreground backdrop-blur">{g.label}</h3>
          <ol className="divide-y divide-border/60">{g.items.map((e) => <EventRow key={e.id} e={e} showProject={showProject} dense />)}</ol>
        </section>
      ))}
    </div>
  )
}
