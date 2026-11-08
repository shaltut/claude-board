import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { get, rpc, type Question, type Task, type User } from '@/lib/api'
import { ago } from '@/lib/format'
import { QuestionCard } from '@/components/QuestionCard'
import { Priority, TaskId } from '@/components/Chips'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

/** What a guest (Omar, Iman) sees through their link: only what Ahmed handed to them. */
export function Guest({ user }: { user: User }) {
  const { data, isLoading } = useQuery({ queryKey: ['me'], queryFn: () => get<{ questions: Question[]; tasks: Task[] }>('/api/me') })
  const open = data?.questions.filter((q) => q.status === 'open') ?? []
  const done = data?.questions.filter((q) => q.status !== 'open') ?? []

  return (
    <div className="min-h-dvh">
      <header className="border-b">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-3">
          <img src="/favicon.svg" alt="" className="size-5" />
          <span className="font-semibold tracking-tight">Claude Board</span>
          <span className="ml-auto text-sm text-muted-foreground">Signed in as {user.display}</span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">
        <h1 className="text-xl font-semibold tracking-tight">Hi {user.display}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Ahmed's team needs your input on these. Pick an option or write your answer; it reaches them right away.
        </p>
        {isLoading ? <p className="mt-6 text-sm text-muted-foreground">Loading…</p> : (
          <>
            <section aria-labelledby="qs" className="mt-6">
              <h2 id="qs" className="mb-3 text-sm font-medium">Questions for you ({open.length})</h2>
              {open.length === 0
                ? <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Nothing is waiting on you right now.</p>
                : <div className="space-y-4">{open.map((q) => <QuestionCard key={q.id} q={q} guest />)}</div>}
            </section>
            {(data?.tasks.length ?? 0) > 0 && (
              <section aria-labelledby="items" className="mt-8">
                <h2 id="items" className="mb-3 text-sm font-medium">Open items for you ({data!.tasks.length})</h2>
                <ul className="space-y-3">{data!.tasks.map((t) => <GuestTask key={t.id} t={t} />)}</ul>
              </section>
            )}
            {done.length > 0 && (
              <section aria-labelledby="done" className="mt-8">
                <h2 id="done" className="mb-3 text-sm font-medium">You answered this week</h2>
                <ul className="space-y-2">
                  {done.map((q) => (
                    <li key={q.id} className="rounded-lg border p-3 text-sm">
                      <p className="text-muted-foreground">{q.body}</p>
                      <p className="mt-1">{q.answer} <span className="text-xs text-muted-foreground">· {ago(q.answered_at)}</span></p>
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

function GuestTask({ t }: { t: Task }) {
  const qc = useQueryClient()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
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
    <li className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <TaskId id={t.id} /><Priority p={t.priority} /><span>updated {ago(t.updated_at)}</span>
      </div>
      <p className="mt-1.5 font-medium text-pretty">{t.title}</p>
      {t.body && <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{t.body}</p>}
      <div className="mt-3 flex items-end gap-2">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Add a note or your decision"
          aria-label={`Note on #${t.id}`} className="min-h-0" />
        <Button onClick={send} disabled={busy || !note.trim()}>Add note</Button>
      </div>
    </li>
  )
}
