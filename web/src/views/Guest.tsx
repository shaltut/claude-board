import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CornerDownRight } from 'lucide-react'
import { toast } from 'sonner'
import { get, rpc, type Question, type Task, type User } from '@/lib/api'
import { ago } from '@/lib/format'
import { cn } from '@/lib/utils'
import { QuestionCard } from '@/components/QuestionCard'
import { PRIORITIES, ProjectChip } from '@/components/Chips'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Mark, ThemeToggle } from '@/components/TopBar'
import { useTabLamp } from '@/components/Mark'

type GuestTask = Task & { my_notes: { summary: string; at: string }[] }

/** What a guest (Omar, Iman) sees through their link: only what Ahmed handed to them.
 *  Tower with the engineering taken out: one column, no callsigns or task numbers, the same lamp. */
export function Guest({ user }: { user: User }) {
  const { data, isLoading } = useQuery({ queryKey: ['me'], queryFn: () => get<{ questions: Question[]; tasks: GuestTask[] }>('/api/me') })
  // Work-holding questions first, then oldest first: the order Ahmed's Today uses.
  const open = (data?.questions.filter((q) => q.status === 'open') ?? [])
    .sort((a, b) => Number(b.blocking) - Number(a.blocking) || +new Date(a.created_at) - +new Date(b.created_at))
  const done = data?.questions.filter((q) => q.status !== 'open') ?? []
  const tasks = data?.tasks ?? []
  useTabLamp(open.length)

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur-md backdrop-saturate-150">
        <div className="mx-auto flex h-13 max-w-2xl items-center gap-2.5 px-4 sm:px-6">
          <Mark lit={open.length > 0} />
          <span className="text-[15px] font-semibold tracking-tight [font-stretch:88%]">Claude Board</span>
          <span className="ml-auto truncate text-sm text-muted-foreground">Signed in as <span className="text-foreground">{user.display}</span></span>
          <ThemeToggle />
        </div>
      </header>

      <main id="main" className="mx-auto max-w-2xl px-4 pt-8 pb-20 sm:px-6 sm:pt-12">
        <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.015em] text-balance">Hi {user.display}</h1>
        <p className="mt-2 flex items-center gap-2.5 text-[15px]">
          {isLoading ? <span className="text-muted-foreground">Loading…</span>
            : open.length > 0
              ? <><span className="lamp size-2 shrink-0" aria-hidden />{open.length === 1 ? 'One question is' : `${open.length} questions are`} waiting on you.</>
              : <><span className="size-2 shrink-0 rounded-full bg-clear shadow-[0_0_10px_var(--clear)]" aria-hidden />Nothing is waiting on you.</>}
        </p>
        <p className="mt-1 max-w-[60ch] text-sm text-muted-foreground text-pretty">
          Ahmed's team asks here when they need your call. Pick an option or write your answer; it reaches them right away.
          This page updates by itself.
        </p>

        {!isLoading && (
          <>
            <section aria-labelledby="qs" className="mt-8">
              <h2 id="qs" className="sr-only">Questions for you</h2>
              {open.length === 0
                ? <p className="rounded-lg border border-dashed px-5 py-6 text-sm text-muted-foreground">When someone needs you, the question appears here and the tab shows a number.</p>
                : <div className="grid gap-3">{open.map((q) => <QuestionCard key={q.id} q={q} guest />)}</div>}
            </section>

            {tasks.length > 0 && (
              <section aria-labelledby="items" className="mt-12">
                <h2 id="items" className="text-sm font-semibold">Also with you</h2>
                <p className="text-xs text-muted-foreground">Things Ahmed handed to you. Add a note when you've moved one along.</p>
                <ul className="mt-3 grid gap-3">{tasks.map((t) => <GuestTask key={t.id} t={t} />)}</ul>
              </section>
            )}

            {done.length > 0 && (
              <section aria-labelledby="done" className="mt-12">
                <h2 id="done" className="text-sm font-semibold">You answered this week</h2>
                <ul className="mt-1 divide-y">
                  {done.map((q) => (
                    <li key={q.id} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2 py-3">
                      <span className="mt-[5px] size-2.5 justify-self-center rounded-full bg-clear" aria-hidden />
                      <div className="min-w-0 text-sm">
                        <p className="text-muted-foreground text-pretty">{q.body}</p>
                        <p className="mt-1 flex items-start gap-1.5">
                          <CornerDownRight className="mt-0.5 size-3.5 shrink-0 text-clear" aria-label="Your answer" />
                          <span className="min-w-0">{q.answer} <span className="ml-1 text-xs text-muted-foreground tabular-nums">{ago(q.answered_at)}</span></span>
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  )
}

function GuestTask({ t }: { t: GuestTask }) {
  const qc = useQueryClient()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const when = PRIORITIES.find((x) => x.p === t.priority)!.label
  async function send() {
    if (!note.trim()) return
    setBusy(true)
    try {
      await rpc('log', { project: t.project, summary: note.trim(), task_id: String(t.id) })
      toast.success('Note added')
      setNote('')
      await qc.invalidateQueries()
    } catch (e: any) {
      toast.error('Could not add the note', { description: e.message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className={cn('relative overflow-hidden rounded-lg border bg-card py-4 pr-4 pl-5',
      'before:absolute before:inset-y-0 before:left-0 before:w-[3px]', t.priority === 'P0' ? 'before:bg-st-blocked' : 'before:bg-transparent')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <ProjectChip slug={t.project} />
        <span className={cn(t.priority === 'P0' && 'font-medium text-st-blocked', t.priority === 'P1' && 'text-foreground')}>{when === 'Someday' ? 'No rush' : `Needed: ${when.toLowerCase()}`}</span>
        <span className="ml-auto tabular-nums">updated {ago(t.updated_at)}</span>
      </div>
      <p className="mt-2 font-medium text-pretty">{t.title}</p>
      {t.body && <p className="mt-1 max-w-[65ch] whitespace-pre-wrap text-sm text-muted-foreground">{t.body}</p>}
      {t.my_notes.length > 0 && (
        <ul className="mt-3 grid gap-1.5 border-l-2 border-input pl-3 text-sm" aria-label="Your notes">
          {t.my_notes.map((n, i) => <li key={i} className="text-pretty">{n.summary} <span className="ml-1 text-xs text-muted-foreground tabular-nums">{ago(n.at)}</span></li>)}
        </ul>
      )}
      <div className="mt-3 flex items-end gap-2">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={1} placeholder="Add a note or your decision…"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() } }}
          aria-label={`Note on ${t.title}`} className="min-h-9 resize-y bg-background/60 text-sm" />
        <Button onClick={send} disabled={busy || !note.trim()} className="shrink-0">Add note</Button>
      </div>
    </li>
  )
}
