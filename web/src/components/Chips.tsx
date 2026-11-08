import { cn } from '@/lib/utils'
import { splitActor, STATUS } from '@/lib/format'
import type { Status, Task } from '@/lib/api'

/** Stable hue per project slug, so a project keeps its colour everywhere. */
export function projectHue(slug: string) {
  let h = 0
  for (const c of slug) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

export function ProjectDot({ slug, className }: { slug: string; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', className)}
    style={{ background: `oklch(0.72 0.12 ${projectHue(slug)})` }} />
}

export function ProjectChip({ slug }: { slug: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <ProjectDot slug={slug} />{slug}
    </span>
  )
}

export function ActorChip({ actor, className }: { actor: string; className?: string }) {
  const { who, where } = splitActor(actor)
  const me = actor === 'ahmed'
  return (
    <span className={cn('inline-flex items-baseline rounded px-1.5 py-px text-xs font-medium',
      me ? 'bg-dawn-soft text-dawn-ink' : 'bg-raised text-foreground/85', className)} title={actor}>
      {who}{where && <span className="ml-0.5 font-normal text-muted-foreground">@{where}</span>}
    </span>
  )
}

export function StatusDot({ status, className }: { status: Status; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', className)}
    style={{ background: STATUS[status].color }} />
}

const PRIO: Record<Task['priority'], string> = {
  P0: 'bg-st-blocked/15 text-st-blocked',
  P1: 'bg-dawn/15 text-dawn',
  P2: 'bg-raised text-muted-foreground',
  P3: 'text-muted-foreground/70',
}
export function Priority({ p }: { p: Task['priority'] }) {
  return <span className={cn('rounded px-1 font-mono text-[11px] leading-5', PRIO[p])}>{p}</span>
}

export function TaskId({ id, className }: { id: number; className?: string }) {
  return <span className={cn('font-mono text-xs text-muted-foreground', className)}>#{id}</span>
}
