import { CheckCircle2, CircleDot, HelpCircle, MessageSquareReply, PencilLine, Plus, Send, StickyNote, XCircle, Megaphone, MessageCircle, MessagesSquare } from 'lucide-react'
import type { CbEvent, Status } from '@/lib/api'
import { clock, day, STATUS } from '@/lib/format'
import { go } from '@/lib/route'
import { cn } from '@/lib/utils'
import { ActorChip, ProjectChip, StatusDot, TaskId } from './Chips'

const ICON: Record<CbEvent['kind'], typeof Plus> = {
  task_created: Plus, moved: CircleDot, updated: PencilLine, done: CheckCircle2, note: StickyNote,
  asked: HelpCircle, answered: MessageSquareReply, delivered: Send, withdrawn: XCircle, broadcast: Megaphone, message: MessageCircle, huddle: MessagesSquare,
}
const TONE: Partial<Record<CbEvent['kind'], string>> = {
  done: 'text-st-done', answered: 'text-clear', asked: 'text-foreground', broadcast: 'text-foreground',
}
const VERB: Partial<Record<CbEvent['kind'], string>> = {
  task_created: 'created', updated: 'edited', done: 'finished', note: 'noted', asked: 'asked', answered: 'answered',
  delivered: 'delivered', withdrawn: 'withdrew', broadcast: 'broadcast', message: 'messaged', huddle: 'in a huddle',
}

/** The DB's default move summary is "next → in_progress"; show it with the board's labels. */
function prettySummary(e: CbEvent) {
  const m = e.summary.match(/^(\w+) → (\w+)$/)
  const a = m && STATUS[m[1] as Status], b = m && STATUS[m[2] as Status]
  return a && b ? `${a.label} → ${b.label}` : e.summary
}

/** One line of the shift log: time, a node on the rail, who did what. */
export function EventRow({ e, showProject, dense }: { e: CbEvent; showProject?: boolean; dense?: boolean }) {
  const Icon = ICON[e.kind] ?? StickyNote // a kind the UI doesn't know yet must not blank the page
  const to = e.data?.to as Status | undefined
  const links = (e.data?.links ?? {}) as Record<string, string>
  const summary = prettySummary(e)
  return (
    <li className={cn('group/ev relative grid grid-cols-[2.75rem_1.25rem_minmax(0,1fr)] gap-x-2.5', dense ? 'py-1.5' : 'py-2')}>
      <time dateTime={e.at} className="pt-[3px] text-right text-xs text-muted-foreground tabular-nums">{clock(e.at)}</time>
      <span aria-hidden className="relative flex justify-center pt-[3px] before:absolute before:inset-y-[-0.5rem] before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-input group-first/ev:before:top-2 group-last/ev:before:bottom-auto group-last/ev:before:h-3">
        <span className="relative grid size-5 place-items-center rounded-full border bg-background">
          {e.kind === 'moved' && to ? <StatusDot status={to} className="size-3" /> : <Icon className={cn('size-3', TONE[e.kind] ?? 'text-muted-foreground')} />}
        </span>
      </span>
      <div className="min-w-0 pt-px text-sm">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <ActorChip actor={e.actor} />
          <span>{e.kind === 'moved' && to ? `moved to ${STATUS[to]?.label ?? to}` : VERB[e.kind] ?? e.kind}</span>
          {e.task_id && <button onClick={() => go({ task: e.task_id! })} className="-mx-1 rounded px-1 hover:bg-raised hover:text-foreground"><TaskId id={e.task_id} className="text-current" /></button>}
          {e.question_id && <span className="callsign text-[12px]">Q{e.question_id}</span>}
          {showProject && e.project && <ProjectChip slug={e.project} />}
        </div>
        {!(e.kind === 'moved' && /→/.test(summary)) && <p className="mt-0.5 text-pretty text-foreground/90">{summary}</p>}
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
    <div className="space-y-3">
      {groups.map((g) => (
        <section key={g.label}>
          <h3 className="sticky top-(--hdr) z-10 -mx-1 bg-background/90 px-1 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur-sm">{g.label}</h3>
          <ol>{g.items.map((e) => <EventRow key={e.id} e={e} showProject={showProject} dense />)}</ol>
        </section>
      ))}
    </div>
  )
}
