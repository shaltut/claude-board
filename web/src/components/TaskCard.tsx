import { forwardRef } from 'react'
import { GitCommitHorizontal, GitPullRequest, GitBranch } from 'lucide-react'
import type { Task } from '@/lib/api'
import { ago } from '@/lib/format'
import { cn } from '@/lib/utils'
import { ActorChip, Priority, ProjectChip, TagChip, TaskId } from './Chips'

type Props = { t: Task; showProject?: boolean; dragging?: boolean; overlay?: boolean } & React.HTMLAttributes<HTMLDivElement>

export const TaskCard = forwardRef<HTMLDivElement, Props>(function TaskCard({ t, showProject, dragging, overlay, className, ...rest }, ref) {
  const l = t.links ?? {}
  return (
    <div ref={ref} {...rest}
      className={cn('group cursor-grab rounded-md border bg-card px-3 py-2.5 text-left outline-none select-none active:cursor-grabbing',
        'hover:border-ring/50 focus-visible:ring-2 focus-visible:ring-ring',
        t.status === 'done' && 'opacity-70', dragging && 'opacity-30', overlay && 'rotate-1 shadow-xl ring-1 ring-ring', className)}>
      <div className="flex items-center gap-2">
        <TaskId id={t.id} />
        <Priority p={t.priority} />
        {showProject && <ProjectChip slug={t.project} />}
        <span className="ml-auto text-[11px] text-muted-foreground">{ago(t.updated_at)}</span>
      </div>
      <p className="mt-1.5 text-sm leading-snug font-medium text-pretty">{t.title}</p>
      {t.labels.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1">{t.labels.map((g) => <TagChip key={g} tag={g} />)}</div>}
      {(t.assignee || t.blocked_on || l.pr || l.commit || l.branch) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {t.assignee && <ActorChip actor={t.assignee} />}
          {t.blocked_on && t.status === 'blocked' && <span className="text-dawn">waiting on Q{t.blocked_on}</span>}
          <span className="ml-auto flex items-center gap-1.5">
            {l.pr && <span className="inline-flex items-center gap-0.5" title={`PR ${l.pr}`}><GitPullRequest className="size-3.5" />{String(l.pr)}</span>}
            {l.commit && <GitCommitHorizontal className="size-3.5" aria-label={`commit ${l.commit}`} />}
            {l.branch && !l.pr && <GitBranch className="size-3.5" aria-label={`branch ${l.branch}`} />}
          </span>
        </div>
      )}
    </div>
  )
})
