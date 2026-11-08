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
      <h2 className="text-xl font-semibold tracking-tight">History</h2>
      <p className="text-sm text-muted-foreground">Everything Claude and you changed, newest first.</p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {KINDS.map((k) => {
          const on = kinds.includes(k.key)
          return (
            <button key={k.key} onClick={() => setKinds((s) => on ? s.filter((x) => x !== k.key) : [...s, k.key])} aria-pressed={on}
              className={cn('rounded-full border px-2.5 py-0.5 text-xs', on ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {k.label}
            </button>
          )
        })}
      </div>
      <div className="mt-3 flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
          <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search what happened" className="h-8 pl-8" />
        </div>
        <Input list="cb-actors" value={actor} onChange={(e) => setActor(e.target.value)} placeholder="Who (e.g. W1@macbook)" className="h-8 w-52" aria-label="Filter by actor" />
        <datalist id="cb-actors">{actors.map((x) => <option key={x} value={x} />)}</datalist>
      </div>

      <div className="mt-6 space-y-6">
        {days.map((d) => (
          <section key={d.label}>
            <h3 className="sticky top-14 z-10 border-b bg-background/95 py-1.5 text-sm font-semibold backdrop-blur">{d.label}</h3>
            <ol className="divide-y divide-border/60">{d.items.map((e) => <EventRow key={e.id} e={e} showProject={!route.project} />)}</ol>
          </section>
        ))}
        {feed.isLoading && <p className="text-sm text-muted-foreground">Loading history…</p>}
        {!feed.isLoading && events.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No events match these filters.</p>}
        {feed.hasNextPage && (
          <Button variant="outline" className="w-full" disabled={feed.isFetchingNextPage} onClick={() => feed.fetchNextPage()}>
            {feed.isFetchingNextPage ? 'Loading…' : 'Show older'}
          </Button>
        )}
      </div>
    </div>
  )
}
