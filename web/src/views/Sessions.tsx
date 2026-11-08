import { useQuery } from '@tanstack/react-query'
import { get, qs, useQuestions, useTasks, type CbEvent, type Task } from '@/lib/api'
import { ago, splitActor, STATUS } from '@/lib/format'
import { go, type Route } from '@/lib/route'
import { cn } from '@/lib/utils'
import { Priority, ProjectChip, StatusDot, TaskId } from '@/components/Chips'
import { Timeline } from '@/components/Timeline'

export interface SessionRow {
  actor: string; project: string | null; machine: string | null; pane: string | null; last_seen: string | null; live: boolean
  doing: { id: number; title: string; priority: Task['priority']; status: Task['status'] }[]
  queued: number; done_24h: number; open_questions: number
  last: { at: string; kind: string; summary: string; task_id: number | null } | null
}

// last_seen moves every time the session's relay checks in, so poll to keep the live dots honest.
const useSessions = (project?: string) =>
  useQuery({ queryKey: ['sessions', project], queryFn: () => get<SessionRow[]>(`/api/sessions${qs({ project })}`), refetchInterval: 30_000 })

export function Sessions({ route }: { route: Route }) {
  const { data = [], isLoading } = useSessions(route.project)
  if (route.actor) return <SessionDetail route={route} row={data.find((s) => s.actor === route.actor)} />
  const live = data.filter((s) => s.live).length

  return (
    <div>
      <div className="mb-5 flex items-baseline gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Sessions</h2>
        {data.length > 0 && <span className="text-sm text-muted-foreground">{data.length} known, {live} with a live relay</span>}
      </div>
      {isLoading ? <p className="text-sm text-muted-foreground">Loading sessions…</p>
        : data.length === 0 ? (
          <div className="rounded-lg border border-dashed px-6 py-10 text-center">
            <p className="font-medium">No sessions yet.</p>
            <p className="mt-1 text-sm text-muted-foreground">A session appears once it runs <code>cb iam &lt;name&gt; &lt;project&gt;</code> or does work on the board.</p>
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {data.filter((s) => !quiet(s)).map((s) => <SessionCard key={s.actor} s={s} showProject={!route.project} />)}
            </div>
            {data.some(quiet) && (
              <details className="mt-6 text-sm">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  {data.filter(quiet).length} quiet sessions: no relay, nothing open
                </summary>
                <div className="mt-3 flex flex-wrap gap-2">
                  {data.filter(quiet).map((s) => (
                    <button key={s.actor} onClick={() => go({ actor: s.actor })}
                      className="rounded-md border px-2 py-1 text-muted-foreground hover:border-ring/50 hover:text-foreground">
                      {s.actor}{s.last && <span className="ml-1.5 text-xs">{ago(s.last.at)}</span>}
                    </button>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
    </div>
  )
}

function LiveDot({ s }: { s: SessionRow }) {
  const title = s.live ? 'Relay live: answers and changes reach this session by themselves'
    : s.last_seen ? `Relay last checked in ${ago(s.last_seen)}` : 'No relay: this session only sees the board when it runs cb'
  return (
    <span title={title} className="relative inline-flex size-2.5 shrink-0">
      {s.live && <span className="absolute inset-0 animate-ping rounded-full bg-st-done opacity-50 motion-reduce:hidden" />}
      <span className={cn('relative size-2.5 rounded-full', s.live ? 'bg-st-done' : 'bg-muted-foreground/40')} />
    </span>
  )
}

function SessionCard({ s, showProject }: { s: SessionRow; showProject: boolean }) {
  const { who, where } = splitActor(s.actor)
  return (
    <button onClick={() => go({ actor: s.actor })}
      className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-left outline-none hover:border-ring/50 focus-visible:ring-2 focus-visible:ring-ring">
      <div className="flex items-center gap-2">
        <LiveDot s={s} />
        <span className="font-semibold">{who}</span>
        {where && <span className="text-sm text-muted-foreground">@{where}</span>}
        {showProject && s.project && <span className="ml-auto"><ProjectChip slug={s.project} /></span>}
      </div>

      {s.doing.length > 0 ? (
        <ul className="space-y-1">
          {s.doing.slice(0, 3).map((t) => (
            <li key={t.id} className="flex items-baseline gap-2 text-sm">
              <StatusDot status={t.status} className="translate-y-[-1px]" />
              <TaskId id={t.id} />
              <span className="line-clamp-1">{t.title}</span>
            </li>
          ))}
          {s.doing.length > 3 && <li className="text-xs text-muted-foreground">and {s.doing.length - 3} more</li>}
        </ul>
      ) : <p className="text-sm text-muted-foreground">Nothing in progress.</p>}

      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2.5 text-xs text-muted-foreground">
        <span><b className="font-semibold tabular-nums text-foreground">{s.queued}</b> queued</span>
        <span><b className="font-semibold tabular-nums text-foreground">{s.done_24h}</b> done today</span>
        <span className={cn(s.open_questions > 0 && 'text-dawn')}><b className="font-semibold tabular-nums">{s.open_questions}</b> asking you</span>
        {s.last && <span className="ml-auto" title={s.last.summary}>active {ago(s.last.at)}</span>}
      </div>
    </button>
  )
}

const quiet = (s: SessionRow) => !s.live && s.doing.length === 0 && s.queued === 0 && s.open_questions === 0

const OPEN: Task['status'][] = ['in_progress', 'blocked', 'review', 'next', 'backlog']

function SessionDetail({ route, row }: { route: Route; row?: SessionRow }) {
  const actor = route.actor!
  const { who, where } = splitActor(actor)
  const { data: tasks = [] } = useTasks(route.project)
  const { data: questions = [] } = useQuestions(route.project)
  const { data: events = [] } = useQuery({
    queryKey: ['events', 'actor', actor, route.project],
    queryFn: () => get<CbEvent[]>(`/api/events${qs({ actor, project: route.project, limit: '100' })}`),
  })
  const mine = tasks.filter((t) => t.assignee === actor && OPEN.includes(t.status)).sort((a, b) => OPEN.indexOf(a.status) - OPEN.indexOf(b.status))
  const asked = questions.filter((q) => q.asked_by === actor && q.status !== 'withdrawn').slice(0, 20)

  return (
    <div>
      <button onClick={() => go({ actor: undefined })} className="mb-3 text-sm text-muted-foreground hover:text-foreground">← All sessions</button>
      <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1">
        {row && <LiveDot s={row} />}
        <h2 className="text-xl font-semibold tracking-tight">{who}<span className="font-normal text-muted-foreground">{where && `@${where}`}</span></h2>
        {row?.project && <ProjectChip slug={row.project} />}
        {row?.pane && <span className="text-sm text-muted-foreground">pane {row.pane} on {row.machine}</span>}
        {row && <span className="text-sm text-muted-foreground">
          {row.live ? 'relay live' : row.last_seen ? `relay last seen ${ago(row.last_seen)}` : 'no relay'}
        </span>}
      </div>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-10">
        <div className="space-y-8">
          <section aria-labelledby="work">
            <h3 id="work" className="mb-2 text-sm font-medium">Assigned work ({mine.length})</h3>
            {mine.length === 0 ? <p className="text-sm text-muted-foreground">Nothing assigned.</p> : (
              <ul className="divide-y rounded-lg border bg-card">
                {mine.map((t) => (
                  <li key={t.id}>
                    <button onClick={() => go({ task: t.id })} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50">
                      <StatusDot status={t.status} /><span className="w-20 shrink-0 text-xs text-muted-foreground">{STATUS[t.status].label}</span>
                      <TaskId id={t.id} /><Priority p={t.priority} /><span className="line-clamp-1">{t.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="asked">
            <h3 id="asked" className="mb-2 text-sm font-medium">Questions it asked ({asked.length})</h3>
            {asked.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
              <ul className="space-y-2">
                {asked.map((q) => (
                  <li key={q.id} className="rounded-lg border bg-card/60 p-3 text-sm">
                    <div className="mb-1 flex gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">Q{q.id}</span><span>{ago(q.created_at)}</span>
                      <span className={cn('ml-auto capitalize', q.status === 'open' && 'text-dawn')}>{q.status}</span>
                    </div>
                    <p>{q.body}</p>
                    {q.answer && <p className="mt-1"><span className="text-dawn">→</span> {q.answer}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <section aria-labelledby="activity" className="lg:border-l lg:pl-10">
          <h3 id="activity" className="mb-3 text-sm font-medium">What it did</h3>
          {events.length === 0 ? <p className="text-sm text-muted-foreground">No activity yet.</p>
            : <Timeline events={events} showProject={!route.project} />}
        </section>
      </div>
    </div>
  )
}
