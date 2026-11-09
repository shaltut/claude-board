import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCorners, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { rpc, useTasks, type Status, type Task } from '@/lib/api'
import { STATUS } from '@/lib/format'
import { bandRank, byQueue, dropIndex } from '@/lib/rank'
import { go, type Route } from '@/lib/route'
import { cn } from '@/lib/utils'
import { StatusDot } from '@/components/Chips'
import { TaskCard } from '@/components/TaskCard'

const COLUMNS: Status[] = ['backlog', 'next', 'in_progress', 'blocked', 'review', 'done']
const HINT: Partial<Record<Status, string>> = { backlog: 'Not ready yet', next: 'Sessions take from the top' }

/** Shared drag-and-drop move: status change (if any) then the rank Ahmed chose. The DB result wins. */
export async function moveTask(t: Task, to: Status, rank: number | null) {
  if (t.status !== to) await rpc('task_move', { id: t.id, status: to })
  if (rank != null) await rpc('task_update', { id: t.id, fields: { rank } })
}

function SortableCard({ t, showProject }: { t: Task; showProject: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: t.id, data: { status: t.status } })
  return (
    <TaskCard ref={setNodeRef} t={t} showProject={showProject} dragging={isDragging}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes} {...listeners}
      onClick={() => go({ task: t.id })}
      onKeyDown={(e) => { if (e.key === 'Enter') go({ task: t.id }); listeners?.onKeyDown?.(e) }} />
  )
}

function Column({ status, tasks, showProject }: { status: Status; tasks: Task[]; showProject: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}`, data: { status } })
  const [collapsed, setCollapsed] = useState(false)
  return (
    <section aria-label={STATUS[status].label} className="flex min-w-0 snap-start flex-col">
      <header className="mb-2 flex h-7 items-center gap-2 px-1">
        <StatusDot status={status} />
        <h2 className="callsign text-[15px]">{STATUS[status].label}</h2>
        <span className="text-[13px] text-muted-foreground tabular-nums">{tasks.length}</span>
        {HINT[status] && <span className="hidden truncate text-xs text-muted-foreground 2xl:inline">{HINT[status]}</span>}
        {status === 'done' && (
          <button onClick={() => setCollapsed((c) => !c)} className="ml-auto grid size-6 place-items-center rounded text-muted-foreground hover:bg-raised hover:text-foreground"
            aria-label={collapsed ? 'Show done' : 'Hide done'} aria-expanded={!collapsed}>
            <ChevronDown className={cn('size-4 transition-transform', collapsed && '-rotate-90')} />
          </button>
        )}
      </header>
      <div ref={setNodeRef}
        className={cn('flex min-h-40 flex-1 flex-col gap-1.5 rounded-lg border border-transparent p-1.5 transition-colors duration-150',
          isOver ? 'border-dashed border-ring/60 bg-ring/8' : 'bg-raised/55')}>
        {!collapsed && (
          <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            {tasks.map((t) => <SortableCard key={t.id} t={t} showProject={showProject} />)}
          </SortableContext>
        )}
        {tasks.length === 0 && <p className="px-2 py-8 text-center text-xs text-muted-foreground">Drop a task here</p>}
        {status === 'done' && !collapsed && tasks.length > 0 && <p className="px-2 pt-1 text-center text-[11px] text-muted-foreground">Last 7 days</p>}
      </div>
    </section>
  )
}

export function Board({ route }: { route: Route }) {
  const qc = useQueryClient()
  const { data = [], isLoading } = useTasks(route.project)
  const [optimistic, setOptimistic] = useState<{ id: number; status: Status; rank: number } | null>(null)
  const [active, setActive] = useState<Task | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const columns = useMemo(() => {
    const rows = data.filter((t) => !route.tag || t.labels.includes(route.tag)).map((t) => (optimistic && t.id === optimistic.id ? { ...t, status: optimistic.status, rank: optimistic.rank } : t))
    const by = Object.fromEntries(COLUMNS.map((s) => [s, [] as Task[]])) as Record<Status, Task[]>
    for (const t of rows) by[t.status]?.push(t)
    for (const s of COLUMNS) by[s].sort((a, b) => (s === 'done' ? +new Date(b.done_at ?? 0) - +new Date(a.done_at ?? 0) : byQueue(a, b)))
    return by
  }, [data, optimistic, route.tag])

  const onStart = (e: DragStartEvent) => setActive(data.find((t) => t.id === e.active.id) ?? null)

  async function onEnd(e: DragEndEvent) {
    setActive(null)
    const t = data.find((x) => x.id === e.active.id)
    if (!t || !e.over) return
    const to = (e.over.data.current?.status ?? t.status) as Status
    const list = columns[to].filter((x) => x.id !== t.id)
    const index = dropIndex(columns[to], t.id, e.over.id, to === t.status)
    if (index === null) return
    const rank = to === 'done' ? null : bandRank(list, index, t.priority)
    setOptimistic({ id: t.id, status: to, rank: rank ?? t.rank })
    try {
      await moveTask(t, to, rank)
      if (to !== t.status) toast(`#${t.id} moved to ${STATUS[to].label}`)
    } catch (err: any) {
      toast.error(`Could not move #${t.id}`, { description: err.message })
    } finally {
      await qc.invalidateQueries()
      setOptimistic(null)
    }
  }

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading the board…</p>

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onStart} onDragEnd={onEnd} onDragCancel={() => setActive(null)}>
      <h1 className="sr-only">Board</h1>
      <div className="-mx-4 grid auto-cols-[minmax(15.5rem,1fr)] grid-flow-col gap-3 overflow-x-auto px-4 pb-4 snap-x snap-mandatory scroll-px-4 xl:snap-none sm:-mx-6 sm:px-6 xl:auto-cols-[minmax(0,1fr)]">
        {COLUMNS.map((s) => <Column key={s} status={s} tasks={columns[s]} showProject={!route.project} />)}
      </div>
      <DragOverlay>{active && <TaskCard t={active} showProject={!route.project} overlay />}</DragOverlay>
    </DndContext>
  )
}
