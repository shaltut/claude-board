import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { get, qs, rpc, useQuestions, type CbEvent, type Question } from '@/lib/api'
import { ago, clock, day } from '@/lib/format'
import { go, type Route } from '@/lib/route'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AnsweredRow, QuestionCard } from '@/components/QuestionCard'
import { Timeline } from '@/components/Timeline'
import { ActorChip, ProjectChip } from '@/components/Chips'

/**
 * "Since you last looked" is anchored once per visit: the stored marker is read on mount and never
 * re-read, so live updates and refreshes can't empty the timeline mid-read. The marker moves forward
 * when Ahmed leaves Today inside the app or clicks "Mark caught up". Closing the tab doesn't move it,
 * so the worst case is a longer timeline next time, never a shorter one.
 */
function useAnchor() {
  const [anchor, setAnchor] = useState<string | null>(null)
  const mountedAt = useRef(Date.now())
  useEffect(() => {
    get<{ at: string }>('/api/last-seen').then((r) => setAnchor(r.at))
    return () => {
      // StrictMode/dev remounts happen within milliseconds; only a real visit advances the marker.
      if (Date.now() - mountedAt.current > 2000) rpc('seen', {}).catch(() => {})
    }
  }, [])
  return [anchor, setAnchor] as const
}

// The anchor lives here, not in Briefing: Today stays mounted across Today ↔ "See every question",
// so visiting the questions list doesn't count as leaving and doesn't move the marker.
export function Today({ route }: { route: Route }) {
  const anchorState = useAnchor()
  if (route.view === 'questions') return <AllQuestions route={route} />
  return <Briefing route={route} anchorState={anchorState} />
}

function Briefing({ route, anchorState }: { route: Route; anchorState: ReturnType<typeof useAnchor> }) {
  const qc = useQueryClient()
  const [anchor, setAnchor] = anchorState
  const [editing, setEditing] = useState<number | null>(null)
  const { data: open = [] } = useQuestions(route.project, 'open')
  const { data: answered = [] } = useQuestions(route.project, 'answered')
  const today = useQuery({
    queryKey: ['today', route.project, anchor], enabled: !!anchor,
    queryFn: () => get<{ counts: { done: number; active: number; blocked: number }; events: CbEvent[] }>(
      `/api/today${qs({ project: route.project, since: anchor ?? undefined })}`),
  })

  async function caughtUp() {
    await rpc('seen', {})
    setAnchor(new Date().toISOString())
    qc.invalidateQueries({ queryKey: ['today'] })
  }

  const c = today.data?.counts
  const events = today.data?.events ?? []
  const blocking = open.filter((q) => q.blocking).length

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-10">
      <section aria-labelledby="waiting">
        <div className="mb-4 flex items-baseline gap-3">
          <h2 id="waiting" className="text-xl font-semibold tracking-tight">Waiting on you</h2>
          {open.length > 0 && (
            <span className="text-sm text-muted-foreground">
              {open.length} {open.length === 1 ? 'question' : 'questions'}{blocking > 0 && <>, <span className="text-dawn">{blocking} blocking</span></>}
            </span>
          )}
        </div>

        {open.length === 0 ? (
          <div className="rounded-lg border border-dashed px-6 py-10 text-center">
            <p className="font-medium">Nothing is waiting on you.</p>
            <p className="mt-1 text-sm text-muted-foreground">New questions from Claude show up here as they're asked.</p>
          </div>
        ) : (
          <div className="space-y-4">{open.map((q) => <QuestionCard key={q.id} q={q} onAnswered={setEditing} />)}</div>
        )}

        {answered.length > 0 && (
          <section className="mt-8" aria-labelledby="pickup">
            <h3 id="pickup" className="text-sm font-medium">Answered, waiting for the orchestrator to pick up</h3>
            <p className="text-xs text-muted-foreground">You can still change these until they're delivered.</p>
            <ul className="mt-1 divide-y">
              {answered.map((q) => (
                <AnsweredRow key={q.id} q={q} editing={editing === q.id} onEdit={(on) => setEditing(on ? q.id : null)} />
              ))}
            </ul>
          </section>
        )}

        <button onClick={() => go({ view: 'questions' })} className="mt-6 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          See every question, including delivered ones
        </button>
      </section>

      <section aria-labelledby="since" className="lg:border-l lg:pl-10">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <h2 id="since" className="text-xl font-semibold tracking-tight">Since you last looked</h2>
            {anchor && <p className="text-sm text-muted-foreground">{day(anchor)} at {clock(anchor)}, {ago(anchor)}</p>}
          </div>
          <Button variant="outline" size="sm" onClick={caughtUp} title="Start the next briefing from now">Mark caught up</Button>
        </div>

        {c && (
          <p className="mb-5 text-[15px] leading-relaxed text-pretty">
            <Count n={c.done} label="done" tone="text-st-done" />, <Count n={c.active} label="in progress" tone="text-st-progress" /> and{' '}
            <Count n={c.blocked} label="blocked" tone="text-st-blocked" /> right now.
          </p>
        )}

        {today.isLoading || !anchor ? (
          <p className="text-sm text-muted-foreground">Loading the shift log…</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activity since then.</p>
        ) : (
          <Timeline events={events} showProject={!route.project} />
        )}
      </section>
    </div>
  )
}

function Count({ n, label, tone }: { n: number; label: string; tone: string }) {
  return <span><span className={cn('font-semibold tabular-nums', n > 0 ? tone : 'text-muted-foreground')}>{n}</span> {label}</span>
}

const FILTERS: { key: string; label: string }[] = [
  { key: '', label: 'All' }, { key: 'open', label: 'Open' }, { key: 'answered', label: 'Answered' },
  { key: 'delivered', label: 'Delivered' }, { key: 'withdrawn', label: 'Withdrawn' },
]

function AllQuestions({ route }: { route: Route }) {
  const [status, setStatus] = useState('')
  const [term, setTerm] = useState('')
  const { data = [] } = useQuestions(route.project, status || undefined)
  const t = term.trim().toLowerCase()
  const rows = t ? data.filter((q) => `${q.body} ${q.answer ?? ''} ${q.asked_by}`.toLowerCase().includes(t)) : data

  return (
    <div className="mx-auto max-w-3xl">
      <button onClick={() => go({ view: 'today' })} className="mb-3 text-sm text-muted-foreground hover:text-foreground">← Back to Today</button>
      <h2 className="text-xl font-semibold tracking-tight">Questions</h2>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button key={f.key} onClick={() => setStatus(f.key)}
            className={cn('rounded-full border px-3 py-1 text-sm', status === f.key ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
            {f.label}
          </button>
        ))}
        <div className="relative ml-auto">
          <Search className="absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
          <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search questions" className="h-8 w-56 pl-8" />
        </div>
      </div>
      <ul className="mt-4 space-y-3">
        {rows.map((q) => q.status === 'open' ? <li key={q.id}><QuestionCard q={q} /></li> : <ClosedQuestion key={q.id} q={q} />)}
        {rows.length === 0 && <li className="py-8 text-center text-sm text-muted-foreground">No questions match.</li>}
      </ul>
    </div>
  )
}

function ClosedQuestion({ q }: { q: Question }) {
  return (
    <li className="rounded-lg border bg-card/60 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-mono">Q{q.id}</span><ProjectChip slug={q.project} /><ActorChip actor={q.asked_by} />
        <span>{ago(q.created_at)}</span>
        <span className="ml-auto capitalize">{q.status}{q.delivered_to ? ` to ${q.delivered_to}` : ''}</span>
      </div>
      <p className="mt-2 text-sm">{q.body}</p>
      {q.answer && <p className="mt-1 text-sm"><span className="text-dawn">→</span> {q.answer}</p>}
    </li>
  )
}
