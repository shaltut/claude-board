import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { onProject, rpc, useTask, useUsers, type Status } from '@/lib/api'
import { ago, STATUS } from '@/lib/format'
import { go } from '@/lib/route'
import { cn } from '@/lib/utils'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ActorChip, Priority, PRIORITIES, ProjectChip, StatusDot, TagChip, TaskId } from './Chips'
import { EventRow } from './Timeline'
import { Md } from './Md'

const STATUSES: Status[] = ['backlog', 'next', 'in_progress', 'blocked', 'review', 'done', 'cancelled']

export function TaskPanel({ id }: { id: number | undefined }) {
  const { data } = useTask(id ?? null)
  return (
    <Sheet open={id != null} onOpenChange={(o) => { if (!o) go({ task: undefined }) }}>
      <SheetContent className="gap-0 overflow-y-auto overscroll-contain p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
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
  const { data: users = [] } = useUsers()
  useEffect(() => { setTitle(t.title); setAssignee(t.assignee ?? '') }, [t.title, t.assignee])
  useEffect(() => { if (!editBody) setBody(t.body) }, [t.body, editBody])

  async function call(fn: string, args: Record<string, unknown>, ok?: string) {
    try { await rpc(fn, { id: t.id, ...args }); if (ok) toast(ok); await qc.invalidateQueries() }
    catch (e: any) { toast.error(e.message) }
  }
  const update = (fields: Record<string, unknown>, ok?: string) => call('task_update', { fields }, ok)

  const links = Object.entries(t.links ?? {})
  const open = data.questions.filter((q) => q.status === 'open' && !q.assigned_to)

  return (
    <div className="flex flex-col">
      <SheetHeader className="gap-3 border-b p-5 pr-12">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <TaskId id={t.id} className="text-[14px] text-foreground" /><ProjectChip slug={t.project} />
          <span>created by <ActorChip actor={t.created_by} /> {ago(t.created_at)}</span>
        </div>
        <SheetTitle className="sr-only">{t.title}</SheetTitle>
        <SheetDescription className="sr-only">Task details and history</SheetDescription>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title"
          onBlur={() => title.trim() && title !== t.title && update({ title: title.trim() })}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          className="-mx-2 h-auto border-transparent bg-transparent px-2 py-1 text-xl leading-snug font-semibold tracking-[-0.01em] shadow-none hover:border-input focus-visible:border-input md:text-xl dark:bg-transparent" />

        <div className="grid gap-3">
          <Field label="Priority">
            <div className="grid grid-cols-4 rounded-md border bg-background p-0.5" role="radiogroup" aria-label="Priority">
              {PRIORITIES.map(({ p, label }) => {
                const on = t.priority === p
                return (
                  <button key={p} role="radio" aria-checked={on} onClick={() => !on && update({ priority: p }, `#${t.id} is now ${p}: ${label.toLowerCase()}`)}
                    className={cn('flex min-h-11 flex-col items-start justify-center gap-0.5 rounded px-2 py-1 text-left transition-colors duration-150 sm:min-h-0 sm:py-1.5',
                      on ? 'bg-foreground text-background [&>span:first-child]:text-background' : 'hover:bg-raised')}>
                    <Priority p={p} />
                    <span className={cn('text-[11px] leading-tight', on ? 'opacity-80' : 'text-muted-foreground')}>{label}</span>
                  </button>
                )
              })}
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Status">
              <Select value={t.status} onValueChange={(v) => call('task_move', { status: v }, `#${t.id} moved to ${STATUS[v as Status].label}`)}>
                <SelectTrigger size="sm" aria-label="Status" className="w-full min-w-0 [&>span]:truncate"><SelectValue /></SelectTrigger>
                <SelectContent>{STATUSES.map((s) => <SelectItem key={s} value={s}><StatusDot status={s} />{STATUS[s].label}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Assignee">
              <datalist id="cb-users">{onProject(users, t.project, t.assignee).map((u) => <option key={u.name} value={u.name}>{u.display}</option>)}</datalist>
              <Input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="nobody, e.g. W1@macbook…" aria-label="Assignee" className="h-8" spellCheck={false} list="cb-users"
                onBlur={() => assignee !== (t.assignee ?? '') && update({ assignee: assignee.trim() || null })}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
            </Field>
          </div>
        </div>
        {t.labels.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {t.labels.map((l) => <TagChip key={l} tag={l} />)}
          </div>
        )}
      </SheetHeader>

      {open.length > 0 && (
        <a href="#/today" onClick={(e) => { e.preventDefault(); go({ view: 'today', task: undefined }) }}
          className="flex items-center gap-3 border-b bg-lamp-soft px-5 py-3 text-sm text-lamp-ink hover:underline">
          <span className="lamp size-2" />
          <span>This task is holding on {open.length === 1 ? `Q${open[0].id}` : `${open.length} questions`}. Answer on Today.</span>
        </a>
      )}

      <section className="border-b p-5">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Description</h3>
          {!editBody && <button onClick={() => setEditBody(true)} className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-raised hover:text-foreground">Edit</button>}
        </div>
        {editBody ? (
          <div className="space-y-2">
            <Textarea autoFocus value={body} onChange={(e) => setBody(e.target.value)} rows={8} className="font-mono text-xs" aria-label="Description (markdown)"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { update({ body }); setEditBody(false) } }} />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => { update({ body }); setEditBody(false) }}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => { setBody(t.body); setEditBody(false) }}>Cancel</Button>
            </div>
          </div>
        ) : t.body ? <Md>{t.body}</Md> : <p className="text-sm text-muted-foreground">No description yet.</p>}

        {links.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {links.map(([k, v]) => (
              <span key={k} className="rounded bg-raised px-1.5 py-0.5 font-mono text-[11px]">
                <span className="text-muted-foreground">{k}</span> {Array.isArray(v) ? v.join(', ') : String(v)}
              </span>
            ))}
          </div>
        )}
      </section>

      {data.questions.length > 0 && (
        <section className="border-b p-5">
          <h3 className="mb-3 text-sm font-semibold">Questions</h3>
          <ul className="space-y-3">
            {data.questions.map((q) => (
              <li key={q.id} className="text-sm">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="callsign text-[12px]">Q{q.id}</span> <ActorChip actor={q.asked_by} />
                  <span className={cn('ml-auto', q.status === 'open' && 'font-medium text-lamp')}>{q.status === 'open' ? 'waiting' : q.status}</span>
                </div>
                <p className="mt-1 text-pretty">{q.body}</p>
                {q.answer && <p className="mt-1 font-medium text-pretty">{q.answer}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="p-5">
        <h3 className="mb-2 text-sm font-semibold">History</h3>
        <ol>{data.events.map((e) => <EventRow key={e.id} e={e} />)}</ol>
      </section>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid gap-1.5 text-xs text-muted-foreground"><span>{label}</span>{children}</div>
}

