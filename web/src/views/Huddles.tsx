import { useQuery } from '@tanstack/react-query'
import { get, qs } from '@/lib/api'
import { ago, clock, splitActor } from '@/lib/format'
import { go, type Route } from '@/lib/route'
import { cn } from '@/lib/utils'
import { ActorChip, ProjectChip, TaskId } from '@/components/Chips'

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
      <div className="mb-5 flex items-baseline gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Huddles</h2>
        {data.length > 0 && <span className="text-sm text-muted-foreground">{open} open, {data.length - open} closed this week</span>}
      </div>
      {isLoading ? <p className="text-sm text-muted-foreground">Loading huddles…</p>
        : data.length === 0 ? (
          <div className="rounded-lg border border-dashed px-6 py-10 text-center">
            <p className="font-medium">No huddles yet.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Sessions open one to talk something through: <code>cb huddle open "topic" W3@macbook -t 59</code>. You'll see every line here as it's said.
            </p>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
            <ul className="space-y-2" aria-label="Huddles">
              {data.map((h) => (
                <li key={h.id}>
                  <button onClick={() => go({ huddle: h.id })} aria-current={h.id === selected}
                    className={cn('w-full rounded-lg border bg-card p-3 text-left outline-none hover:border-ring/50 focus-visible:ring-2 focus-visible:ring-ring',
                      h.id === selected && 'border-ring', h.status === 'closed' && 'opacity-70')}>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className={cn('size-2 rounded-full', h.status === 'open' ? 'bg-st-done' : 'bg-muted-foreground/40')} />
                      <span>{h.status === 'open' ? 'Open' : 'Closed'}</span>
                      {!route.project && <ProjectChip slug={h.project} />}
                      <span className="ml-auto">{ago(h.last?.at ?? h.opened_at)}</span>
                    </div>
                    <p className="mt-1 font-medium text-pretty">{h.topic}</p>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {h.summary ? `Outcome: ${h.summary}` : h.last ? `${splitActor(h.last.actor).who}: ${h.last.summary}` : ''}
                    </p>
                    <p className="mt-1.5 text-xs text-muted-foreground">{h.members.map((m) => splitActor(m).who).join(', ')} · {h.messages} lines</p>
                  </button>
                </li>
              ))}
            </ul>
            {selected != null && <ThreadView id={selected} />}
          </div>
        )}
    </div>
  )
}

function ThreadView({ id }: { id: number }) {
  const { data: h } = useQuery({ queryKey: ['huddle', id], queryFn: () => get<Thread>(`/api/huddles/${id}`) })
  if (!h) return <p className="text-sm text-muted-foreground">Loading…</p>
  return (
    <section aria-labelledby="thread" className="rounded-lg border bg-card">
      <header className="border-b p-4">
        <h3 id="thread" className="text-lg font-semibold tracking-tight text-pretty">{h.topic}</h3>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>Huddle #{h.id}</span>
          {h.task_id && <button onClick={() => go({ task: h.task_id! })} className="hover:text-foreground"><TaskId id={h.task_id} /></button>}
          <span>opened by {h.opened_by} {ago(h.opened_at)}</span>
          {h.status === 'closed' && <span>· closed {ago(h.closed_at)}</span>}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">{h.members.map((m) => <ActorChip key={m} actor={m} />)}</div>
      </header>
      <ol className="space-y-3 p-4">
        {h.lines.map((l) => l.action === 'say' ? (
          <li key={l.id} className="text-sm">
            <div className="flex items-baseline gap-2">
              <span className="font-semibold">{splitActor(l.actor).who}</span>
              <time className="text-xs text-muted-foreground tabular-nums" dateTime={l.at}>{clock(l.at)}</time>
            </div>
            <p className="mt-0.5 whitespace-pre-wrap text-pretty">{l.summary}</p>
          </li>
        ) : (
          <li key={l.id} className="text-xs text-muted-foreground">
            <span className="tabular-nums">{clock(l.at)}</span> {splitActor(l.actor).who} {l.summary}
          </li>
        ))}
      </ol>
      {h.status === 'closed' && h.summary && (
        <footer className="border-t p-4 text-sm"><span className="font-medium">Outcome:</span> {h.summary}</footer>
      )}
    </section>
  )
}
