import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Bug, Milestone } from 'lucide-react'
import { cn } from '@/lib/utils'
import { splitActor, STATUS } from '@/lib/format'
import { rpc, useEpics, type Status, type Task } from '@/lib/api'
import { go } from '@/lib/route'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

/** Stable hue per project slug, so a project keeps its colour everywhere. */
export function projectHue(slug: string) {
  let h = 0
  for (const c of slug) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

/** Projects are small squares; statuses are circles; the lamp is the only glowing dot. */
export function ProjectDot({ slug, className }: { slug: string; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-[2px]', className)}
    style={{ background: `oklch(0.68 0.11 ${projectHue(slug)})` }} />
}

export function ProjectChip({ slug }: { slug: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <ProjectDot slug={slug} /><span className="truncate">{slug}</span>
    </span>
  )
}

/** A session's callsign: "W1" in strip lettering, the machine after it. */
export function ActorChip({ actor, className }: { actor: string; className?: string }) {
  const { who, where } = splitActor(actor)
  const me = actor === 'ahmed'
  return (
    <span className={cn('inline-flex items-baseline gap-px whitespace-nowrap text-xs', className)} title={actor} translate="no">
      <span className={cn('callsign text-[13px]', me ? 'rounded-[3px] bg-foreground px-1 text-background' : 'text-foreground')}>{me ? 'Ahmed' : who}</span>
      {where && <span className="text-muted-foreground">@{where}</span>}
    </span>
  )
}

/** Status as a shape as well as a colour, so it reads without colour too. */
export function StatusDot({ status, className }: { status: Status; className?: string }) {
  const c = STATUS[status].color
  return (
    <svg viewBox="0 0 14 14" aria-hidden className={cn('size-3.5 shrink-0', className)} style={{ color: c }}>
      {status === 'backlog' && <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 1.9" />}
      {status === 'next' && <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" />}
      {status === 'in_progress' && <><circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" /></>}
      {status === 'review' && <><circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M7 3.5a3.5 3.5 0 1 1-3.5 3.5H7z" fill="currentColor" /></>}
      {status === 'blocked' && <><circle cx="7" cy="7" r="6" fill="currentColor" /><path d="M4.25 7h5.5" stroke="var(--card)" strokeWidth="1.6" strokeLinecap="round" /></>}
      {status === 'done' && <><circle cx="7" cy="7" r="6" fill="currentColor" /><path d="m4.4 7.2 1.8 1.8 3.5-3.7" fill="none" stroke="var(--card)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></>}
      {status === 'cancelled' && <><circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="m5 5 4 4m0-4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></>}
    </svg>
  )
}

export const PRIORITIES: { p: Task['priority']; label: string }[] = [
  { p: 'P0', label: 'Drop everything' },
  { p: 'P1', label: 'Today' },
  { p: 'P2', label: 'This week' },
  { p: 'P3', label: 'Someday' },
]

/** Signal bars: P0 is a solid stop block, P1–P3 light three, two, one bar. */
function PriorityGlyph({ p }: { p: Task['priority'] }) {
  if (p === 'P0') return (
    <svg viewBox="0 0 12 12" aria-hidden className="size-3 shrink-0 text-st-blocked">
      <rect width="12" height="12" rx="2.5" fill="currentColor" /><path d="M6 2.8v3.8" stroke="var(--card)" strokeWidth="1.6" strokeLinecap="round" /><circle cx="6" cy="9" r=".95" fill="var(--card)" />
    </svg>
  )
  const lit = { P1: 3, P2: 2, P3: 1 }[p]
  return (
    <svg viewBox="0 0 12 12" aria-hidden className="size-3 shrink-0">
      {[0, 1, 2].map((i) => <rect key={i} x={1 + i * 4} y={8 - i * 3} width="2.4" height={3 + i * 3} rx=".7"
        fill="currentColor" opacity={i < lit ? 1 : 0.22} />)}
    </svg>
  )
}

const PRIO_TONE: Record<Task['priority'], string> = {
  P0: 'text-st-blocked', P1: 'text-foreground', P2: 'text-muted-foreground', P3: 'text-muted-foreground',
}

/** Read-only priority. */
export function Priority({ p }: { p: Task['priority'] }) {
  return (
    <span className={cn('inline-flex items-center gap-1 text-[12px] leading-5', PRIO_TONE[p])} title={`${p}: ${PRIORITIES.find((x) => x.p === p)!.label}`}>
      <PriorityGlyph p={p} /><span className="callsign">{p}</span>
    </span>
  )
}

export async function setPriority(id: number, priority: Task['priority']) {
  await rpc('task_update', { id, fields: { priority } })
}

/** Priority you can change in one click: open, pick, saved. Safe inside a draggable card. */
export function PriorityPicker({ t, className }: { t: Pick<Task, 'id' | 'priority'>; className?: string }) {
  const qc = useQueryClient()
  async function pick(v: string) {
    const p = v as Task['priority']
    if (p === t.priority) return
    try {
      await setPriority(t.id, p)
      toast(`#${t.id} is now ${p}: ${PRIORITIES.find((x) => x.p === p)!.label.toLowerCase()}`)
    } catch (e: any) { toast.error(`Could not change #${t.id}`, { description: e.message }) }
    await qc.invalidateQueries()
  }
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
        aria-label={`Priority ${t.priority}, change`}
        className={cn('-mx-1 inline-flex h-5 items-center rounded px-1 outline-none transition-colors hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-raised', className)}>
        <Priority p={t.priority} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}>
        <DropdownMenuRadioGroup value={t.priority} onValueChange={pick}>
          {PRIORITIES.map(({ p, label }) => (
            <DropdownMenuRadioItem key={p} value={p} className="gap-2">
              <span className={cn('flex w-9 items-center gap-1', PRIO_TONE[p])}><PriorityGlyph p={p} /><span className="callsign text-[12px]">{p}</span></span>
              <span>{label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TaskId({ id, className }: { id: number; className?: string }) {
  return <span className={cn('callsign text-[13px] text-muted-foreground', className)}>#{id}</span>
}

/** Task type, shown only when not the default 'task'. A bug is the one type that earns colour (red, like
 *  blocked); the rest are a quiet word. Click filters Board and Backlog to that type; it doesn't open the card. */
export function TypeChip({ type, active, className }: { type: Task['type']; active?: boolean; className?: string }) {
  if (!type || (type === 'task' && !active)) return null
  const bug = type === 'bug'
  return (
    <button type="button" title={active ? `Showing only ${type}s` : `Show only ${type}s`} aria-pressed={active}
      aria-label={active ? `${type}s` : type}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); go({ type }) }}
      className={cn('inline-flex h-5 items-center gap-1 rounded-[4px] text-[11.5px] leading-none transition-colors',
        bug ? 'text-st-blocked hover:text-foreground' : 'text-muted-foreground hover:text-foreground',
        active ? 'px-1.5 text-foreground ring-1 ring-foreground/40' : '-mx-0.5 px-0.5', className)}
      style={active ? { background: bug ? 'color-mix(in oklab, var(--st-blocked) 16%, transparent)' : 'var(--raised)' } : undefined}>
      {bug && <Bug className={cn('size-3.5', active && 'text-st-blocked')} aria-hidden />}
      {(active || !bug) && <span>{active ? `${type}s` : type}</span>}
    </button>
  )
}

/** The epic a task is a step of: E3 and its title. Click opens the epic; it doesn't open the card. */
export function EpicChip({ id, className }: { id: number; className?: string }) {
  const { data: epics = [] } = useEpics()
  const e = epics.find((x) => x.id === id)
  return (
    <button type="button" title={e ? `Step of E${id}: ${e.title}` : `Step of epic E${id}`} aria-label={`Open epic E${id}${e ? `, ${e.title}` : ''}`}
      onPointerDown={(ev) => ev.stopPropagation()}
      onClick={(ev) => { ev.stopPropagation(); go({ view: 'epics', epic: id, task: undefined }) }}
      className={cn('inline-flex h-5 max-w-[13rem] min-w-0 items-center gap-1 rounded-[4px] bg-raised px-1.5 text-[11.5px] leading-none text-muted-foreground transition-colors hover:text-foreground', className)}>
      <Milestone className="size-3 shrink-0" aria-hidden />
      <span className="callsign shrink-0 text-[12px] text-foreground/85">E{id}</span>
      {e && <span className="truncate">{e.title}</span>}
    </button>
  )
}

/** "waits on #12": the open tasks this one is blocked by. Each number opens that task. */
export function WaitsOn({ ids, className }: { ids: number[]; className?: string }) {
  if (!ids.length) return null
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs text-foreground/80', className)}>
      <StatusDot status="blocked" className="size-3" />
      <span>waits on</span>
      {ids.map((id) => (
        <button key={id} type="button" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); go({ task: id }) }}
          className="callsign rounded px-0.5 text-[13px] text-foreground hover:bg-raised hover:underline" aria-label={`Open blocker #${id}`}>#{id}</button>
      ))}
    </span>
  )
}

/** A tag (work stream). Click filters Board and Backlog to it; it doesn't open the card. */
export function TagChip({ tag, active, className }: { tag: string; active?: boolean; className?: string }) {
  const h = projectHue(tag)
  return (
    <button type="button" title={active ? `Showing only ${tag}` : `Show only ${tag}`} aria-pressed={active}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); go({ tag }) }}
      className={cn('inline-flex h-5 items-center gap-px rounded-[4px] px-1.5 text-[11.5px] leading-none text-muted-foreground transition-colors hover:text-foreground',
        active && 'text-foreground ring-1 ring-foreground/40', className)}
      style={{ background: `oklch(0.7 0.09 ${h} / ${active ? 0.26 : 0.13})` }}>
      <span aria-hidden className="opacity-60">#</span>{tag}
    </button>
  )
}
