import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useDroppable, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { rpc, useProjects, useTasks, type Status, type Task } from '@/lib/api'
import { ago } from '@/lib/format'
import { bandRank, dropIndex } from '@/lib/rank'
import { go, type Route } from '@/lib/route'
import { cn } from '@/lib/utils'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ActorChip, Priority, ProjectChip, TaskId } from '@/components/Chips'
import { moveTask } from './Board'

function Row({ t, showProject, selected, onSelect }: { t: Task; showProject: boolean; selected?: boolean; onSelect?: (on: boolean) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: t.id, data: { status: t.status } })
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('group flex items-center gap-3 border-b bg-background px-2 py-2 last:border-b-0', isDragging && 'relative z-10 opacity-60 shadow-lg')}>
      <button {...attributes} {...listeners} className="cursor-grab text-muted-foreground/50 hover:text-foreground active:cursor-grabbing" aria-label={`Reorder #${t.id}`}>
        <GripVertical className="size-4" />
      </button>
      {onSelect && <Checkbox checked={selected} onCheckedChange={(v) => onSelect(!!v)} aria-label={`Select #${t.id}`} />}
      <TaskId id={t.id} className="w-10 shrink-0" />
      <Priority p={t.priority} />
      <button onClick={() => go({ task: t.id })} className="min-w-0 flex-1 truncate text-left text-sm hover:underline">{t.title}</button>
      <span className="hidden shrink-0 items-center gap-3 text-xs text-muted-foreground sm:flex">
        {showProject && <ProjectChip slug={t.project} />}
        {t.assignee && <ActorChip actor={t.assignee} />}
        <span className="w-16 text-right">{ago(t.created_at)}</span>
      </span>
    </li>
  )
}

function List({ status, tasks, children, empty }: { status: Status; tasks: Task[]; children: React.ReactNode; empty: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `list:${status}`, data: { status } })
  return (
    <ul ref={setNodeRef} className={cn('rounded-lg border', isOver && 'ring-2 ring-ring/40')}>
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>{children}</SortableContext>
      {tasks.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted-foreground">{empty}</li>}
    </ul>
  )
}

export function Backlog({ route }: { route: Route }) {
  const qc = useQueryClient()
  const { data: nextAll = [] } = useTasks(route.project, 'next')
  const { data: backlogAll = [] } = useTasks(route.project, 'backlog')
  const tagged = (ts: Task[]) => (route.tag ? ts.filter((t) => t.labels.includes(route.tag!)) : ts)
  const next = useMemo(() => tagged(nextAll), [nextAll, route.tag])
  const backlog = useMemo(() => tagged(backlogAll), [backlogAll, route.tag])
  const { data: projects = [] } = useProjects()
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [title, setTitle] = useState('')
  const [proj, setProj] = useState('')
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const lists = useMemo(() => ({ next, backlog }), [next, backlog])
  const showProject = !route.project

  async function onEnd(e: DragEndEvent) {
    const all = [...next, ...backlog]
    const t = all.find((x) => x.id === e.active.id)
    if (!t || !e.over) return
    const to = (e.over.data.current?.status ?? t.status) as 'next' | 'backlog'
    const list = lists[to].filter((x) => x.id !== t.id)
    const index = dropIndex(lists[to], t.id, e.over.id, to === t.status)
    if (index === null) return
    try { await moveTask(t, to, bandRank(list, index, t.priority)) } catch (err: any) { toast.error(err.message) }
    await qc.invalidateQueries()
  }

  async function bulk(status: Status) {
    const ids = [...selected]
    try {
      for (const id of ids) await rpc('task_move', { id, status })
      toast(`${ids.length} ${ids.length === 1 ? 'task' : 'tasks'} moved to ${status === 'next' ? 'Next' : 'Cancelled'}`)
      setSelected(new Set())
    } catch (err: any) { toast.error(err.message) }
    await qc.invalidateQueries()
  }

  async function quickAdd(e: React.FormEvent) {
    e.preventDefault()
    const project = route.project ?? proj
    if (!title.trim() || !project.trim()) return
    try {
      const id = await rpc<number>('task_add', { project, title, status: 'backlog' })
      setTitle('')
      toast(`Added #${id} to the backlog`)
    } catch (err: any) { toast.error(err.message) }
    await qc.invalidateQueries()
  }

  const toggle = (id: number) => (on: boolean) =>
    setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n })

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onEnd}>
      <div className="mx-auto grid max-w-4xl gap-8">
        <section aria-labelledby="nextup">
          <h2 id="nextup" className="text-xl font-semibold tracking-tight">Next up</h2>
          <p className="mb-3 text-sm text-muted-foreground">Sessions take from the top with <code className="font-mono text-xs">cb next</code>. Drag to set the order.</p>
          <List status="next" tasks={next} empty="Nothing queued. Drag tasks up from the backlog.">
            {next.map((t) => <Row key={t.id} t={t} showProject={showProject} />)}
          </List>
        </section>

        <section aria-labelledby="backlog">
          <div className="mb-3 flex items-end justify-between gap-4">
            <div>
              <h2 id="backlog" className="text-xl font-semibold tracking-tight">Backlog</h2>
              <p className="text-sm text-muted-foreground">{backlog.length} {backlog.length === 1 ? 'task' : 'tasks'} not yet queued.</p>
            </div>
            {selected.size > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">{selected.size} selected</span>
                <Button size="sm" onClick={() => bulk('next')}>Move to Next</Button>
                <Button size="sm" variant="ghost" onClick={() => bulk('cancelled')}>Cancel tasks</Button>
              </div>
            )}
          </div>
          <form onSubmit={quickAdd} className="mb-2 flex gap-2">
            <div className="relative flex-1">
              <Plus className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add to the backlog and press Enter" className="pl-8" aria-label="New backlog task" />
            </div>
            {!route.project && (
              <>
                <Input required list="cb-projects-bl" value={proj} onChange={(e) => setProj(e.target.value)} placeholder="project" className="w-40" aria-label="Project" />
                <datalist id="cb-projects-bl">{projects.map((p) => <option key={p.slug} value={p.slug} />)}</datalist>
              </>
            )}
          </form>
          <List status="backlog" tasks={backlog} empty="The backlog is empty.">
            {backlog.map((t) => <Row key={t.id} t={t} showProject={showProject} selected={selected.has(t.id)} onSelect={toggle(t.id)} />)}
          </List>
        </section>
      </div>
    </DndContext>
  )
}
