import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowLeft, GripVertical, Milestone, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { rpc, useEpic, useEpics, useProjects, useTasks, type Epic, type Task } from '@/lib/api'
import { ago, STATUS } from '@/lib/format'
import { dropIndex, rankAt } from '@/lib/rank'
import { go, type Route } from '@/lib/route'
import { cn } from '@/lib/utils'
import { ActorChip, ProjectChip, StatusDot, TaskId, WaitsOn } from '@/components/Chips'
import { NewTask } from '@/components/NewTask'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'

/** Epics (8): Ahmed's plan, one level deep. The list, or one epic's steps with ?e=<id>. */
export function Epics({ route }: { route: Route }) {
  return route.epic ? <EpicPage key={route.epic} id={route.epic} /> : <EpicList route={route} />
}

async function act(fn: string, args: Record<string, unknown>, ok?: string) {
  try { const r = await rpc(fn, args); if (ok) toast(ok); return r }
  catch (e: any) { toast.error(e.message); return undefined }
}

/** "3 of 7 done": a hairline bar, done in green, cancelled as a hatched grey run after it. */
function Progress({ e, className }: { e: Epic; className?: string }) {
  const pct = (n: number) => (e.total ? (n / e.total) * 100 : 0)
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <div className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-raised sm:w-36" aria-hidden>
        <div className="flex h-full">
          <div className="h-full bg-st-done" style={{ width: `${pct(e.done)}%` }} />
          <div className="h-full bg-[repeating-linear-gradient(135deg,var(--st-backlog)_0_2px,transparent_2px_4px)]" style={{ width: `${pct(e.cancelled)}%` }} />
        </div>
      </div>
      <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
        <span className="font-medium text-foreground">{e.finished} of {e.total}</span> done{e.cancelled > 0 && `, ${e.cancelled} cancelled`}
      </span>
    </div>
  )
}

function EpicStatus({ e }: { e: Epic }) {
  const done = e.status === 'done'
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', done ? 'text-st-done' : 'text-muted-foreground')}>
      <StatusDot status={done ? 'done' : 'in_progress'} className="size-3" />{done ? (e.closed ? 'Closed' : 'Done') : 'Open'}
    </span>
  )
}

function EpicList({ route }: { route: Route }) {
  const [creating, setCreating] = useState(false)
  const { data = [], isLoading } = useEpics(route.project)
  const open = data.filter((e) => e.status === 'open')
  const done = data.filter((e) => e.status === 'done')

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.015em]">Epics</h1>
          <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground text-pretty">
            Ordered steps toward one goal, inside one project. The order is your plan, not a lock: a step waits only on its blockers.
            {data.length > 0 && ` ${open.length} open, ${done.length} done.`}
          </p>
        </div>
        <Button className="ml-auto" onClick={() => setCreating(true)}><Plus /> New epic</Button>
      </header>
      <NewEpic key={route.project ?? ''} open={creating} onOpenChange={setCreating} project={route.project} />

      {isLoading ? <p className="text-sm text-muted-foreground">Loading epics…</p>
        : data.length === 0 ? (
          <div className="rounded-lg border border-dashed px-6 py-10 text-center">
            <p className="font-medium">No epics yet.</p>
            <p className="mx-auto mt-1 max-w-[60ch] text-sm text-muted-foreground text-pretty">
              Start one with <strong className="font-medium text-foreground">New epic</strong>: a title and a short goal. Then add its steps here,
              or let sessions put their tasks in it (<code className="font-mono text-xs">cb add … --epic E1</code>).
            </p>
          </div>
        ) : (
          <div className="grid gap-8">
            {open.length > 0 && <EpicRows epics={open} showProject={!route.project} label="Open" />}
            {done.length > 0 && <EpicRows epics={done} showProject={!route.project} label="Done" />}
          </div>
        )}
    </div>
  )
}

function EpicRows({ epics, showProject, label }: { epics: Epic[]; showProject: boolean; label: string }) {
  return (
    <section aria-label={`${label} epics`}>
      <h2 className="callsign mb-2 px-1 text-[15px]">{label} <span className="font-normal text-muted-foreground tabular-nums">{epics.length}</span></h2>
      <ul className="overflow-hidden rounded-lg border bg-card">
        {epics.map((e) => (
          <li key={e.id} className="border-b last:border-b-0">
            <a href={`#/epics?e=${e.id}`} onClick={(ev) => { if (ev.metaKey || ev.ctrlKey) return; ev.preventDefault(); go({ epic: e.id }) }}
              className="grid gap-x-4 gap-y-1.5 px-4 py-3 outline-none transition-colors hover:bg-raised/50 focus-visible:bg-raised/60 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="min-w-0">
                <div className="flex min-w-0 items-baseline gap-2.5">
                  <span className="callsign w-7 shrink-0 text-[14px] text-muted-foreground">E{e.id}</span>
                  <span className={cn('truncate font-medium', e.status === 'done' && 'text-muted-foreground')}>{e.title}</span>
                </div>
                {e.goal && <p className="mt-0.5 truncate pl-[2.375rem] text-[13px] text-muted-foreground">{e.goal}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:justify-end">
                {showProject && <ProjectChip slug={e.project} />}
                <Progress e={e} />
                <span className="w-16"><EpicStatus e={e} /></span>
              </div>
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Ahmed starts an epic: project, title and a short goal. */
function NewEpic({ open, onOpenChange, project }: { open: boolean; onOpenChange: (o: boolean) => void; project?: string }) {
  const qc = useQueryClient()
  const { data: projects = [] } = useProjects()
  const [proj, setProj] = useState(project ?? '')
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  async function create(e: React.FormEvent) {
    e.preventDefault()
    const id = await act('epic_create', { project: proj, title, goal })
    if (id == null) return
    setTitle(''); setGoal('')
    onOpenChange(false)
    await qc.invalidateQueries()
    go({ epic: Number(id) })
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={create} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New epic</DialogTitle>
            <DialogDescription>A goal in one project, reached in ordered steps. Sessions can add their tasks to it; only you rename or close it.</DialogDescription>
          </DialogHeader>
          <Input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title, e.g. Payer gateway hardening…" aria-label="Title" />
          <Input required list="cb-projects-epic" value={proj} onChange={(e) => setProj(e.target.value)} placeholder="project…" spellCheck={false} aria-label="Project" />
          <datalist id="cb-projects-epic">{projects.map((p) => <option key={p.slug} value={p.slug} />)}</datalist>
          <Textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} placeholder="The goal in a sentence or two: done when…" aria-label="Goal" />
          <DialogFooter><Button type="submit">Create epic</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function EpicPage({ id }: { id: number }) {
  const qc = useQueryClient()
  const { data, isLoading } = useEpic(id)
  const [adding, setAdding] = useState(false)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading E{id}…</p>
  if (!data) return (
    <div className="mx-auto max-w-5xl">
      <Back />
      <p className="text-sm text-muted-foreground">There is no epic E{id}. It may have been deleted.</p>
    </div>
  )
  const { epic: e, steps } = data
  const refresh = () => qc.invalidateQueries()

  async function onEnd(ev: DragEndEvent) {
    if (!ev.over) return
    const index = dropIndex(steps, Number(ev.active.id), ev.over.id, true)
    if (index === null) return
    const rest = steps.filter((x) => x.id !== ev.active.id)
    await act('task_update', { id: ev.active.id, fields: { epic_rank: rankAt(rest.map((x) => ({ rank: x.epic_rank })), index) } })
    await refresh()
  }

  return (
    <div className="mx-auto max-w-5xl">
      <Back />
      <EpicHeader e={e} />

      <section aria-labelledby="steps" className="mt-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="steps" className="text-xl leading-tight font-semibold tracking-[-0.01em]">Steps</h2>
            <p className="text-sm text-muted-foreground">Drag to set the order. Any step can start; only its blockers hold it.</p>
          </div>
          <Button size="sm" onClick={() => setAdding(true)}><Plus /> New step</Button>
        </div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onEnd}>
          <ol className="overflow-hidden rounded-lg border bg-card">
            <SortableContext items={steps.map((t) => t.id)} strategy={verticalListSortingStrategy}>
              {steps.map((t, i) => <Step key={t.id} t={t} place={i + 1} epic={e} onChange={refresh} />)}
            </SortableContext>
            {steps.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted-foreground">No steps yet. Create one, or add a task from {e.project} below.</li>}
          </ol>
        </DndContext>
        <AddExisting e={e} steps={steps} onAdded={refresh} />
      </section>
      <NewTask key={e.id} open={adding} onOpenChange={setAdding} project={e.project} epic={{ id: e.id, title: e.title }} />
    </div>
  )
}

function Back() {
  return (
    <a href="#/epics" onClick={(ev) => { ev.preventDefault(); go({ epic: undefined }) }}
      className="mb-4 inline-flex items-center gap-1.5 rounded px-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-3.5" /> All epics
    </a>
  )
}

/** Title (rename in place), goal, progress, and Ahmed's close / reopen / delete. */
function EpicHeader({ e }: { e: Epic }) {
  const qc = useQueryClient()
  const [title, setTitle] = useState(e.title)
  const [goal, setGoal] = useState(e.goal)
  const [editGoal, setEditGoal] = useState(false)
  useEffect(() => setTitle(e.title), [e.title])
  useEffect(() => { if (!editGoal) setGoal(e.goal) }, [e.goal, editGoal])
  const save = async (args: Record<string, unknown>, ok: string) => { await act('epic_update', { id: e.id, ...args }, ok); await qc.invalidateQueries() }
  async function close(closed: boolean) {
    await act('epic_close', { id: e.id, closed }, closed ? `E${e.id} closed` : `E${e.id} reopened`)
    await qc.invalidateQueries()
  }
  async function remove() {
    if (!confirm(`Delete E${e.id} "${e.title}"? Its ${e.total} tasks stay on the board, outside any epic.`)) return
    if (await act('epic_delete', { id: e.id }, `E${e.id} deleted; its tasks stay`) === undefined) return
    go({ epic: undefined })
    await qc.invalidateQueries()
  }

  return (
    <header className="rounded-[10px] border bg-card p-5 shadow-[inset_3px_0_0_var(--foreground)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><Milestone className="size-3.5" /><span className="callsign text-[14px] text-foreground">E{e.id}</span></span>
        <ProjectChip slug={e.project} />
        <EpicStatus e={e} />
        <span>started by <ActorChip actor={e.created_by} /> {ago(e.created_at)}</span>
      </div>
      <Input value={title} onChange={(ev) => setTitle(ev.target.value)} aria-label="Epic title"
        onBlur={() => title.trim() && title.trim() !== e.title && save({ title: title.trim() }, `E${e.id} renamed`)}
        onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur() }}
        className="-mx-2 mt-2 h-auto border-transparent bg-transparent px-2 py-1 text-[24px] leading-tight font-semibold tracking-[-0.015em] shadow-none hover:border-input focus-visible:border-input md:text-[24px] dark:bg-transparent" />
      {editGoal ? (
        <div className="mt-2 space-y-2">
          <Textarea autoFocus value={goal} onChange={(ev) => setGoal(ev.target.value)} rows={3} aria-label="Goal"
            onKeyDown={(ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { save({ goal }, 'Goal saved'); setEditGoal(false) } }} />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => { save({ goal }, 'Goal saved'); setEditGoal(false) }}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditGoal(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <button onClick={() => setEditGoal(true)} className="mt-1 block max-w-[75ch] rounded text-left text-sm text-pretty text-muted-foreground hover:text-foreground">
          {e.goal || 'Add a goal: what is true when this epic is done…'}
        </button>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3">
        <Progress e={e} />
        <div className="ml-auto flex gap-2">
          {e.closed
            ? <Button size="sm" variant="outline" onClick={() => close(false)}>Reopen</Button>
            : <Button size="sm" variant="outline" onClick={() => close(true)}>Close epic</Button>}
          <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-st-blocked" onClick={remove}>Delete</Button>
        </div>
      </div>
    </header>
  )
}

function Step({ t, place, epic, onChange }: { t: Task; place: number; epic: Epic; onChange: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: t.id })
  const cancelled = t.status === 'cancelled'
  const waits = t.status === 'done' || cancelled ? [] : t.waits_on ?? []
  async function remove() {
    if (await act('task_update', { id: t.id, fields: { epic: 'none' } }, `#${t.id} is out of E${epic.id}`) !== undefined) onChange()
  }
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('group flex min-h-12 flex-wrap items-center gap-x-2.5 gap-y-1 border-b bg-card px-2 py-2 last:border-b-0 sm:flex-nowrap sm:gap-3',
        isDragging && 'relative z-10 rounded-md border opacity-90 shadow-[0_12px_30px_-10px_rgb(0_0_0/0.4)]')}>
      <button {...attributes} {...listeners} className="grid h-7 w-5 shrink-0 cursor-grab touch-none place-items-center rounded text-muted-foreground/45 hover:bg-raised hover:text-foreground active:cursor-grabbing" aria-label={`Reorder #${t.id}`}>
        <GripVertical className="size-4" />
      </button>
      <span className="callsign w-5 shrink-0 text-right text-[13px] text-muted-foreground" title={`Step ${place}`}>{place}</span>
      <span className={cn('inline-flex w-[6.5rem] shrink-0 items-center gap-1.5 text-xs', t.status === 'done' ? 'text-st-done' : 'text-muted-foreground')}>
        <StatusDot status={t.status} />{STATUS[t.status].label}
      </span>
      <TaskId id={t.id} className="w-9 shrink-0" />
      <a href={`#/epics?e=${epic.id}&t=${t.id}`} onClick={(ev) => { ev.preventDefault(); go({ task: t.id }) }}
        className={cn('order-last min-w-0 basis-full truncate pb-0.5 pl-[3.75rem] text-sm font-medium hover:underline hover:underline-offset-4 sm:order-none sm:flex-1 sm:basis-auto sm:pb-0 sm:pl-0',
          (cancelled || t.status === 'done') && 'text-muted-foreground', cancelled && 'line-through')}>
        {t.title}
      </a>
      {/* phone: status, id, waits and holder on the first line, the title under them */}
      <span className="ml-auto flex shrink-0 items-center gap-3">
        <WaitsOn ids={waits} />
        {t.assignee && <ActorChip actor={t.assignee} />}
        <button onClick={remove} className="grid size-7 place-items-center rounded text-muted-foreground/60 hover:bg-raised hover:text-foreground"
          aria-label={`Remove #${t.id} from E${epic.id}`} title="Remove from this epic (the task stays)">
          <X className="size-3.5" />
        </button>
      </span>
    </li>
  )
}

/** Put a task of the epic's project that is in no epic yet into this one, as its last step. */
function AddExisting({ e, steps, onAdded }: { e: Epic; steps: Task[]; onAdded: () => void }) {
  const [pick, setPick] = useState('')
  const { data: tasks = [] } = useTasks(e.project)
  const ids = new Set(steps.map((s) => s.id))
  const options = tasks.filter((t) => !ids.has(t.id) && t.epic_id == null).sort((a, b) => b.id - a.id)
  async function add(ev: React.FormEvent) {
    ev.preventDefault()
    const id = Number(/#?(\d+)/.exec(pick)?.[1])
    if (!id) return
    if (await act('task_update', { id, fields: { epic: `E${e.id}` } }, `#${id} added to E${e.id}`) === undefined) return
    setPick('')
    onAdded()
  }
  return (
    <form onSubmit={add} className="mt-3 flex gap-2">
      <datalist id="cb-epic-add">{options.map((t) => <option key={t.id} value={`#${t.id}`}>{t.title}</option>)}</datalist>
      <Input value={pick} onChange={(ev) => setPick(ev.target.value)} list="cb-epic-add" spellCheck={false} className="max-w-sm"
        placeholder={`Add a task from ${e.project}: #id…`} aria-label={`Add an existing ${e.project} task by number`} />
      <Button type="submit" variant="outline" disabled={!/\d/.test(pick)}>Add step</Button>
    </form>
  )
}
