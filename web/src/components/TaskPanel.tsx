import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { rpc, useTask, type Status, type Task } from '@/lib/api'
import { ago, STATUS } from '@/lib/format'
import { go } from '@/lib/route'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ActorChip, ProjectChip, StatusDot, TaskId } from './Chips'
import { EventRow } from './Timeline'
import { Md } from './Md'

const STATUSES: Status[] = ['backlog', 'next', 'in_progress', 'blocked', 'review', 'done', 'cancelled']
const PRIORITIES: Task['priority'][] = ['P0', 'P1', 'P2', 'P3']

export function TaskPanel({ id }: { id: number | undefined }) {
  const { data } = useTask(id ?? null)
  return (
    <Sheet open={id != null} onOpenChange={(o) => { if (!o) go({ task: undefined }) }}>
      <SheetContent className="gap-0 overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        {data ? <PanelBody key={data.task.id} data={data} /> : (
          <SheetHeader><SheetTitle>Task #{id}</SheetTitle><SheetDescription>Loading…</SheetDescription></SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  )
}

function PanelBody({ data }: { data: NonNullable<ReturnType<typeof useTask>['data']> }) {
  const qc = useQueryClient()
  const t = data.task
  const [title, setTitle] = useState(t.title)
  const [body, setBody] = useState(t.body)
  const [editBody, setEditBody] = useState(false)
  const [assignee, setAssignee] = useState(t.assignee ?? '')
  useEffect(() => { setTitle(t.title); setAssignee(t.assignee ?? '') }, [t.title, t.assignee])
  useEffect(() => { if (!editBody) setBody(t.body) }, [t.body, editBody])

  async function call(fn: string, args: Record<string, unknown>, ok?: string) {
    try { await rpc(fn, { id: t.id, ...args }); if (ok) toast(ok); await qc.invalidateQueries() }
    catch (e: any) { toast.error(e.message) }
  }
  const update = (fields: Record<string, unknown>) => call('task_update', { fields })

  const links = Object.entries(t.links ?? {})

  return (
    <div className="flex flex-col">
      <SheetHeader className="gap-3 border-b p-5 pr-12">
        <div className="flex items-center gap-2 text-xs">
          <TaskId id={t.id} /><ProjectChip slug={t.project} />
          <span className="text-muted-foreground">created by {t.created_by}, {ago(t.created_at)}</span>
        </div>
        <SheetTitle className="sr-only">{t.title}</SheetTitle>
        <SheetDescription className="sr-only">Task details and history</SheetDescription>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title"
          onBlur={() => title.trim() && title !== t.title && update({ title: title.trim() })}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          className="h-auto border-transparent bg-transparent px-0 text-lg font-semibold md:text-lg shadow-none hover:border-input focus-visible:border-input focus-visible:px-2" />
        <div className="grid grid-cols-[1.4fr_0.8fr_1.2fr] gap-2">
          <Field label="Status">
            <Select value={t.status} onValueChange={(v) => call('task_move', { status: v }, `#${t.id} moved to ${STATUS[v as Status].label}`)}>
              <SelectTrigger size="sm" className="w-full min-w-0 [&>span]:truncate"><SelectValue /></SelectTrigger>
              <SelectContent>{STATUSES.map((s) => <SelectItem key={s} value={s}><StatusDot status={s} />{STATUS[s].label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={t.priority} onValueChange={(v) => update({ priority: v })}>
              <SelectTrigger size="sm" className="w-full min-w-0 [&>span]:truncate"><SelectValue /></SelectTrigger>
              <SelectContent>{PRIORITIES.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Assignee">
            <Input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="nobody" className="h-8"
              onBlur={() => assignee !== (t.assignee ?? '') && update({ assignee: assignee.trim() || null })}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
          </Field>
        </div>
      </SheetHeader>

      <section className="border-b p-5">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium">Description</h3>
          {!editBody && <button onClick={() => setEditBody(true)} className="text-xs text-muted-foreground hover:text-foreground">Edit</button>}
        </div>
        {editBody ? (
          <div className="space-y-2">
            <Textarea autoFocus value={body} onChange={(e) => setBody(e.target.value)} rows={8} className="font-mono text-xs"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { update({ body }); setEditBody(false) } }} />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => { update({ body }); setEditBody(false) }}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => { setBody(t.body); setEditBody(false) }}>Cancel</Button>
            </div>
          </div>
        ) : t.body ? <Md>{t.body}</Md> : <p className="text-sm text-muted-foreground">No description yet.</p>}

        {(links.length > 0 || t.labels.length > 0) && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {links.map(([k, v]) => (
              <span key={k} className="rounded bg-raised px-1.5 py-0.5 font-mono text-[11px]">
                <span className="text-muted-foreground">{k}</span> {Array.isArray(v) ? v.join(', ') : String(v)}
              </span>
            ))}
            {t.labels.map((l) => <span key={l} className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">{l}</span>)}
          </div>
        )}
      </section>

      {data.questions.length > 0 && (
        <section className="border-b p-5">
          <h3 className="mb-2 text-sm font-medium">Questions</h3>
          <ul className="space-y-2">
            {data.questions.map((q) => (
              <li key={q.id} className="text-sm">
                <span className="font-mono text-xs text-dawn">Q{q.id}</span> <ActorChip actor={q.asked_by} /> <span className="text-muted-foreground">{q.status}</span>
                <p className="mt-0.5">{q.body}</p>
                {q.answer && <p className="text-muted-foreground"><span className="text-dawn">→</span> {q.answer}</p>}
              </li>
            ))}
          </ul>
          {data.questions.some((q) => q.status === 'open') && (
            <button onClick={() => go({ view: 'today', task: undefined })} className="mt-2 text-xs text-dawn hover:underline">Answer on Today</button>
          )}
        </section>
      )}

      <section className="p-5">
        <h3 className="mb-1 text-sm font-medium">History</h3>
        <ol className="divide-y divide-border/60">{data.events.map((e) => <EventRow key={e.id} e={e} />)}</ol>
      </section>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1 text-xs text-muted-foreground">{label}{children}</label>
}
