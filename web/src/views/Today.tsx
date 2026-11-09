import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, BookMarked, Search } from 'lucide-react'
import { get, qs, rpc, useMemStats, useQuestions, useUsers, type CbEvent, type Question } from '@/lib/api'
import { ago, clock, day } from '@/lib/format'
import { go, type Route } from '@/lib/route'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AnsweredRow, QuestionCard } from '@/components/QuestionCard'
import { MakeRule } from '@/components/MakeRule'
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

/** Same order as the API: blocking first, then oldest first. */
const byWaiting = (a: Question, b: Question) => Number(b.blocking) - Number(a.blocking) || a.created_at.localeCompare(b.created_at)

/**
 * Answered strips stay on screen until their clearance animation ends, even though the live
 * refetch has already dropped them from the open list.
 */
function useClearing(open: Question[]) {
  const [leaving, setLeaving] = useState<Map<number, Question>>(new Map())
  const shown = [...open, ...[...leaving.values()].filter((l) => !open.some((q) => q.id === l.id))].sort(byWaiting)
  const hold = (q: Question) => setLeaving((m) => new Map(m).set(q.id, q))
  const gone = (id: number) => setLeaving((m) => { const n = new Map(m); n.delete(id); return n })
  return { shown, hold, gone }
}

function Briefing({ route, anchorState }: { route: Route; anchorState: ReturnType<typeof useAnchor> }) {
  const qc = useQueryClient()
  const [anchor, setAnchor] = anchorState
  const [editing, setEditing] = useState<number | null>(null)
  const { data: allOpen = [], isLoading } = useQuestions(route.project, 'open')
  const open = allOpen.filter((q) => !q.assigned_to)
  const others = allOpen.filter((q) => q.assigned_to)
  const { data: users = [] } = useUsers()
  const { data: answered = [] } = useQuestions(route.project, 'answered')
  const clearing = useClearing(open)
  // Strips already there on arrival sit still; only questions asked while you watch slide in.
  const initial = useRef<Set<number> | null>(null)
  if (!initial.current && !isLoading) initial.current = new Set(allOpen.map((q) => q.id))
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
    <div className="grid gap-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-0">
      <section aria-labelledby="waiting" className="lg:pr-10">
        <header className="mb-5">
          <h1 id="waiting" className="text-[28px] leading-tight font-semibold tracking-[-0.015em]">
            {open.length === 0 && !isLoading ? 'All clear' : 'Waiting on you'}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {open.length === 0 ? 'No session is waiting on you.'
              : <>{open.length} {open.length === 1 ? 'question' : 'questions'}{blocking > 0 && <>; <span className="font-medium text-lamp">{blocking} holding work</span></>}. Click an option to answer.</>}
          </p>
        </header>

        {open.length === 0 && clearing.shown.length === 0 ? (
          <div className="flex items-start gap-4 rounded-lg border border-dashed px-5 py-6">
            <span className="mt-1.5 size-2.5 shrink-0 rounded-full bg-clear shadow-[0_0_12px_var(--clear)]" aria-hidden />
            <div>
              <p className="font-medium">Nothing is holding.</p>
              <p className="mt-0.5 text-sm text-muted-foreground">A question shows up here, and lights the tab, the moment a session asks one.</p>
            </div>
          </div>
        ) : (
          <div className="grid gap-3">
            {clearing.shown.map((q) => (
              <div key={q.id} className={cn(!initial.current?.has(q.id) && 'strip-in')}>
                <QuestionCard q={q} onAnswered={setEditing} onClearing={clearing.hold} onCleared={clearing.gone} />
              </div>
            ))}
          </div>
        )}

        {others.length > 0 && (
          <details className="group mt-6">
            <summary className="cursor-pointer list-none text-sm text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              <span className="mr-1 inline-block transition-transform group-open:rotate-90">›</span>
              Waiting on others: {[...new Set(others.map((q) => q.assigned_to!))].map((u) =>
                `${users.find((x) => x.name === u)?.display ?? u} (${others.filter((q) => q.assigned_to === u).length})`).join(', ')}
            </summary>
            <div className="mt-3 grid gap-3">{others.map((q) => <QuestionCard key={q.id} q={q} />)}</div>
          </details>
        )}

        {answered.length > 0 && (
          <section className="mt-10" aria-labelledby="pickup">
            <h2 id="pickup" className="text-sm font-semibold">Answered, on the way</h2>
            <p className="text-xs text-muted-foreground">The orchestrator hasn't delivered these yet, so you can still change them.</p>
            <ul className="mt-1 divide-y">
              {answered.map((q) => (
                <AnsweredRow key={q.id} q={q} editing={editing === q.id} onEdit={(on) => setEditing(on ? q.id : null)} />
              ))}
            </ul>
          </section>
        )}

        <MemoryCard project={route.project} />

        <a href="#/questions" onClick={(e) => { e.preventDefault(); go({ view: 'questions' }) }}
          className="mt-6 inline-block text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          Every question, including delivered ones
        </a>
      </section>

      <section aria-labelledby="since" className="lg:border-l lg:pl-10">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="since" className="text-xl leading-tight font-semibold tracking-[-0.01em]">Since you last looked</h2>
            {anchor && <p className="mt-1 text-sm text-muted-foreground">{day(anchor)} at <span className="tabular-nums">{clock(anchor)}</span>, {ago(anchor)}</p>}
          </div>
          <Button variant="outline" size="sm" onClick={caughtUp} title="Start the next briefing from now">Mark caught up</Button>
        </div>

        {c && (
          <p className="mb-6 text-[15px] leading-relaxed text-pretty">
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

/** Shared memory waiting on you (#553): proposals to confirm and live entries past their review date. Hidden at 0 and 0. */
function MemoryCard({ project }: { project?: string }) {
  const { data: m } = useMemStats(project)
  if (!m || (m.proposed === 0 && m.past_review === 0)) return null
  return (
    <a href="#/memory" onClick={(e) => { e.preventDefault(); go({ view: 'memory' }) }}
      className="mt-6 flex items-center gap-3 rounded-lg border bg-card px-4 py-3 text-sm transition-colors hover:border-foreground/35">
      <BookMarked className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="font-medium">Memory</span>
      <span className="text-muted-foreground">
        <span className={cn('callsign', m.proposed > 0 && 'text-lamp')}>{m.proposed}</span> proposed
        {' · '}<span className={cn('callsign', m.past_review > 0 && 'text-st-blocked')}>{m.past_review}</span> past review
      </span>
    </a>
  )
}

function Count({ n, label, tone }: { n: number; label: string; tone: string }) {
  return <span className="whitespace-nowrap"><span className={cn('callsign text-[17px]', n > 0 ? tone : 'text-muted-foreground')}>{n}</span> {label}</span>
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
      <a href="#/today" onClick={(e) => { e.preventDefault(); go({ view: 'today' }) }}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Today
      </a>
      <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.015em]">Questions</h1>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border bg-card p-0.5" role="group" aria-label="Filter by status">
          {FILTERS.map((f) => (
            <button key={f.key} onClick={() => setStatus(f.key)} aria-pressed={status === f.key}
              className={cn('rounded px-2.5 py-1 text-sm transition-colors', status === f.key ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative ml-auto w-full sm:w-60">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
          <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search questions and answers…" className="h-8 pl-8" aria-label="Search questions" />
        </div>
      </div>
      <ul className="mt-5 grid gap-3">
        {rows.map((q) => q.status === 'open' ? <li key={q.id}><QuestionCard q={q} /></li> : <ClosedQuestion key={q.id} q={q} />)}
        {rows.length === 0 && <li className="py-10 text-center text-sm text-muted-foreground">No questions match.</li>}
      </ul>
    </div>
  )
}

function ClosedQuestion({ q }: { q: Question }) {
  return (
    <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] rounded-lg border bg-card/60 py-4 pr-4 sm:grid-cols-[2.5rem_minmax(0,1fr)]">
      <span className={cn('mt-[5px] size-2.5 justify-self-center rounded-full', q.status === 'withdrawn' ? 'border-2 border-muted-foreground/50' : q.status === 'delivered' ? 'bg-clear' : 'border-2 border-clear')} aria-hidden />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <ActorChip actor={q.asked_by} /><ProjectChip slug={q.project} />
          <span className="tabular-nums">{ago(q.created_at)}</span>
          <span className="callsign text-[12px]">Q{q.id}</span>
          <span className="ml-auto capitalize">{q.status}{q.delivered_to ? ` to ${q.delivered_to}` : ''}</span>
        </div>
        <p className="mt-2 text-sm text-pretty">{q.body}</p>
        {q.answer && <p className="mt-1.5 text-sm font-medium text-pretty">{q.answer}</p>}
        {q.answer && <div className="mt-1.5 -ml-1.5"><MakeRule q={q} /></div>}
      </div>
    </li>
  )
}
