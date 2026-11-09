import { useDeferredValue, useMemo, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { get, qs, type CbEvent } from '@/lib/api'
import { day } from '@/lib/format'
import type { Route } from '@/lib/route'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { EventRow } from '@/components/Timeline'

const KINDS: { key: CbEvent['kind']; label: string }[] = [
  { key: 'task_created', label: 'Created' }, { key: 'moved', label: 'Moved' }, { key: 'done', label: 'Done' },
  { key: 'updated', label: 'Edited' }, { key: 'note', label: 'Notes' }, { key: 'asked', label: 'Asked' },
  { key: 'answered', label: 'Answered' }, { key: 'delivered', label: 'Delivered' },
]
const PAGE = 100

export function History({ route }: { route: Route }) {
  const [kinds, setKinds] = useState<string[]>([])
  const [actor, setActor] = useState('')
  const [term, setTerm] = useState('')
  const q = useDeferredValue(term.trim())
  const a = useDeferredValue(actor.trim())

  const feed = useInfiniteQuery({
    queryKey: ['events', route.project, kinds.join(','), a, q],
    initialPageParam: '',
    queryFn: ({ pageParam }) => get<CbEvent[]>(`/api/events${qs({
      project: route.project, kind: kinds.join(',') || undefined, actor: a || undefined, q: q || undefined,
      before: pageParam || undefined, limit: String(PAGE),
    })}`),
    getNextPageParam: (last) => (last.length === PAGE ? last.at(-1)!.at : undefined),
  })
  const events = useMemo(() => feed.data?.pages.flat() ?? [], [feed.data])
  const actors = useMemo(() => [...new Set(events.map((e) => e.actor))].sort(), [events])

  const days: { label: string; items: CbEvent[] }[] = []
  for (const e of events) {
    const label = day(e.at)
    if (days.at(-1)?.label === label) days.at(-1)!.items.push(e)
    else days.push({ label, items: [e] })
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.015em]">History</h1>
      <p className="mt-1 text-sm text-muted-foreground">Everything Claude and you changed, newest first.</p>

      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
          <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search what happened…" className="h-8 pl-8" aria-label="Search history" />
        </div>
        <Input list="cb-actors" value={actor} onChange={(e) => setActor(e.target.value)} placeholder="Who, e.g. W1@macbook…" className="h-8 sm:w-52" aria-label="Filter by actor" spellCheck={false} />
        <datalist id="cb-actors">{actors.map((x) => <option key={x} value={x} />)}</datalist>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1" role="group" aria-label="Filter by kind">
        {KINDS.map((k) => {
          const on = kinds.includes(k.key)
          return (
            <button key={k.key} onClick={() => setKinds((s) => on ? s.filter((x) => x !== k.key) : [...s, k.key])} aria-pressed={on}
              className={cn('h-7 rounded-md border px-2.5 text-xs transition-colors duration-150',
                on ? 'border-foreground bg-foreground text-background' : 'bg-card text-muted-foreground hover:border-input hover:text-foreground')}>
              {k.label}
            </button>
          )
        })}
        {kinds.length > 0 && <button onClick={() => setKinds([])} className="ml-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">Clear</button>}
      </div>

      <div className="mt-8 space-y-8">
        {days.map((d) => (
          <section key={d.label}>
            <h2 className="sticky top-(--hdr) z-10 -mx-1 mb-1 border-b bg-background/90 px-1 py-2 text-sm font-semibold backdrop-blur-sm">{d.label}</h2>
            <ol>{d.items.map((e) => <EventRow key={e.id} e={e} showProject={!route.project} />)}</ol>
          </section>
        ))}
        {feed.isLoading && <p className="text-sm text-muted-foreground">Loading history…</p>}
        {!feed.isLoading && events.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">No events match these filters.</p>}
        {feed.hasNextPage && (
          <Button variant="outline" className="w-full" disabled={feed.isFetchingNextPage} onClick={() => feed.fetchNextPage()}>
            {feed.isFetchingNextPage ? 'Loading…' : 'Show older'}
          </Button>
        )}
      </div>
    </div>
  )
}
