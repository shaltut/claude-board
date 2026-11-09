import { useQuery } from '@tanstack/react-query'
import { get, qs } from '@/lib/api'
import { ago, clock, splitActor } from '@/lib/format'
import { go, type Route } from '@/lib/route'
import { cn } from '@/lib/utils'
import { ActorChip, projectHue, ProjectChip, TaskId } from '@/components/Chips'

interface HuddleRow {
  id: number; project: string; topic: string; task_id: number | null; opened_by: string; status: 'open' | 'closed'
  summary: string | null; opened_at: string; closed_at: string | null; members: string[]; messages: number
  last: { actor: string; summary: string; at: string } | null
}
interface Line { id: number; at: string; actor: string; summary: string; action: 'open' | 'add' | 'say' | 'close' }
type Thread = Omit<HuddleRow, 'messages' | 'last'> & { lines: Line[] }

export function Huddles({ route }: { route: Route }) {
  const { data = [], isLoading } = useQuery({
    queryKey: ['huddles', route.project], queryFn: () => get<HuddleRow[]>(`/api/huddles${qs({ project: route.project })}`),
  })
  const selected = route.huddle ?? data.find((h) => h.status === 'open')?.id ?? data[0]?.id
  const open = data.filter((h) => h.status === 'open').length

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.015em]">Huddles</h1>
        {data.length > 0 && <p className="mt-1 text-sm text-muted-foreground">{open} open, {data.length - open} closed this week. Sessions talk things through here; you see every line.</p>}
      </header>
      {isLoading ? <p className="text-sm text-muted-foreground">Loading huddles…</p>
        : data.length === 0 ? (
          <div className="rounded-lg border border-dashed px-6 py-10 text-center">
            <p className="font-medium">No huddles yet.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Sessions open one to talk something through: <code className="font-mono text-xs">cb huddle open "topic" W3@macbook -t 59</code>. You'll see every line here as it's said.
            </p>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
            <ul className="space-y-1.5" aria-label="Huddles">
              {data.map((h) => {
                const on = h.id === selected
                return (
                  <li key={h.id}>
                    <a href={`#/huddles?h=${h.id}`} onClick={(e) => { e.preventDefault(); go({ huddle: h.id }) }} aria-current={on ? 'true' : undefined}
                      className={cn('block rounded-lg border p-3 outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring',
                        on ? 'border-input bg-card shadow-[inset_3px_0_0_var(--foreground)]' : 'border-transparent hover:bg-card/70')}>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className={cn('size-2 rounded-full', h.status === 'open' ? 'bg-clear shadow-[0_0_8px_var(--clear)]' : 'border border-muted-foreground/60')} />
                        <span>{h.status === 'open' ? 'Open' : 'Closed'}</span>
                        {!route.project && <ProjectChip slug={h.project} />}
                        <span className="ml-auto tabular-nums">{ago(h.last?.at ?? h.opened_at)}</span>
                      </div>
                      <p className={cn('mt-1.5 font-medium text-pretty', h.status === 'closed' && 'text-muted-foreground')}>{h.topic}</p>
                      <p className="mt-1 line-clamp-2 text-[13px] text-muted-foreground">
                        {h.summary ? `Outcome: ${h.summary}` : h.last ? `${splitActor(h.last.actor).who}: ${h.last.summary}` : ''}
                      </p>
                      <div className="mt-2 flex items-center gap-2">
                        <Faces members={h.members} />
                        <span className="text-xs text-muted-foreground tabular-nums">{h.messages} lines</span>
                      </div>
                    </a>
                  </li>
                )
              })}
            </ul>
            {selected != null && <ThreadView id={selected} />}
          </div>
        )}
    </div>
  )
}

/** A callsign tile: the session's short name on a tint of its own hue. */
function Tile({ actor, className }: { actor: string; className?: string }) {
  const { who } = splitActor(actor)
  const h = projectHue(who)
  return (
    <span aria-hidden className={cn('callsign grid size-7 shrink-0 place-items-center rounded-md text-[12px] text-foreground', className)}
      style={{ background: `oklch(0.7 0.1 ${h} / 0.22)`, boxShadow: `inset 0 0 0 1px oklch(0.7 0.1 ${h} / 0.35)` }}>
      {who.slice(0, 2)}
    </span>
  )
}

function Faces({ members }: { members: string[] }) {
  return (
    <span className="flex -space-x-1.5">
      {members.slice(0, 5).map((m) => <Tile key={m} actor={m} className="size-5 rounded-[5px] text-[9.5px] ring-2 ring-background" />)}
    </span>
  )
}

function ThreadView({ id }: { id: number }) {
  const { data: h } = useQuery({ queryKey: ['huddle', id], queryFn: () => get<Thread>(`/api/huddles/${id}`) })
  if (!h) return <p className="text-sm text-muted-foreground">Loading…</p>
  return (
    <section aria-labelledby="thread" className="overflow-hidden rounded-lg border bg-card">
      <header className="border-b p-5">
        <h2 id="thread" className="text-lg leading-snug font-semibold tracking-[-0.01em] text-pretty">{h.topic}</h2>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className={cn('flex items-center gap-1.5', h.status === 'open' && 'text-foreground')}>
            <span className={cn('size-2 rounded-full', h.status === 'open' ? 'bg-clear shadow-[0_0_8px_var(--clear)]' : 'border border-muted-foreground/60')} />
            {h.status === 'open' ? 'Open' : `Closed ${ago(h.closed_at)}`}
          </span>
          {h.task_id && <button onClick={() => go({ task: h.task_id! })} className="-mx-1 rounded px-1 hover:bg-raised hover:text-foreground">on <TaskId id={h.task_id} className="text-current" /></button>}
          <span>opened by <ActorChip actor={h.opened_by} /> {ago(h.opened_at)}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5">{h.members.map((m) => <ActorChip key={m} actor={m} />)}</div>
      </header>
      <ol className="space-y-0.5 p-3 sm:p-4">
        {h.lines.map((l, i) => {
          if (l.action !== 'say') return (
            <li key={l.id} className="flex items-center gap-3 py-1.5 pl-10 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              <span><span className="tabular-nums">{clock(l.at)}</span> {splitActor(l.actor).who} {l.summary}</span>
              <span className="h-px flex-1 bg-border" />
            </li>
          )
          const prev = h.lines[i - 1]
          const cont = prev?.action === 'say' && prev.actor === l.actor
          return (
            <li key={l.id} className={cn('grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 rounded-md px-1 py-1 hover:bg-raised/40', !cont && 'mt-2')}>
              {cont ? <span /> : <Tile actor={l.actor} />}
              <div className="min-w-0">
                {!cont && (
                  <div className="flex items-baseline gap-2">
                    <ActorChip actor={l.actor} />
                    <time className="text-xs text-muted-foreground tabular-nums" dateTime={l.at}>{clock(l.at)}</time>
                  </div>
                )}
                <p className="mt-0.5 max-w-[70ch] text-[14.5px] leading-relaxed whitespace-pre-wrap text-pretty">{l.summary}</p>
              </div>
            </li>
          )
        })}
      </ol>
      {h.status === 'closed' && h.summary && (
        <footer className="border-t bg-raised/50 p-5">
          <p className="text-xs font-medium text-muted-foreground">Outcome</p>
          <p className="mt-1 font-medium text-pretty">{h.summary}</p>
        </footer>
      )}
    </section>
  )
}
