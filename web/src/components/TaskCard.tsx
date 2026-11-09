import { forwardRef } from 'react'
import { GitCommitHorizontal, GitPullRequest, GitBranch } from 'lucide-react'
import { useQuestions, type Task } from '@/lib/api'
import { ago } from '@/lib/format'
import { cn } from '@/lib/utils'
import { ActorChip, PriorityPicker, ProjectChip, TagChip, TaskId, TypeChip } from './Chips'

type Props = { t: Task; showProject?: boolean; dragging?: boolean; overlay?: boolean } & React.HTMLAttributes<HTMLDivElement>

/** A flight strip. The left edge only speaks when it matters: amber when the task holds on a
 *  question to Ahmed, red for P0. */
export const TaskCard = forwardRef<HTMLDivElement, Props>(function TaskCard({ t, showProject, dragging, overlay, className, ...rest }, ref) {
  const l = t.links ?? {}
  const { data: open = [] } = useQuestions(undefined, 'open')
  const holding = t.status === 'blocked' && t.blocked_on != null && open.some((q) => q.id === t.blocked_on && !q.assigned_to)
  const edge = holding ? 'before:bg-lamp' : t.priority === 'P0' && t.status !== 'done' ? 'before:bg-st-blocked' : 'before:bg-transparent'
  return (
    <div ref={ref} {...rest}
      className={cn('group relative cursor-grab overflow-hidden rounded-md border bg-card py-2.5 pr-3 pl-3.5 text-left outline-none select-none active:cursor-grabbing',
        'before:absolute before:inset-y-0 before:left-0 before:w-[3px]', edge,
        'transition-[border-color,box-shadow] duration-150 hover:border-input hover:shadow-[0_1px_0_var(--border)] focus-visible:ring-2 focus-visible:ring-ring',
        t.status === 'done' && 'bg-card/60', dragging && 'opacity-30',
        overlay && 'rotate-[1.5deg] cursor-grabbing shadow-[0_18px_40px_-12px_rgb(0_0_0/0.45)] ring-1 ring-ring', className)}>
      <div className="flex items-center gap-2">
        <TaskId id={t.id} />
        <PriorityPicker t={t} />
        <TypeChip type={t.type} />
        {showProject && <ProjectChip slug={t.project} />}
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">{ago(t.updated_at)}</span>
      </div>
      <p className={cn('mt-1 text-sm leading-snug font-medium text-pretty', t.status === 'done' && 'text-muted-foreground')}>{t.title}</p>
      {t.labels.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{t.labels.map((g) => <TagChip key={g} tag={g} />)}</div>}
      {(t.assignee || holding || l.pr || l.commit || l.branch) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {t.assignee && <ActorChip actor={t.assignee} />}
          {holding && <span className="flex items-center gap-1.5 font-medium text-lamp"><span className="lamp size-1.5" />holding on Q{t.blocked_on}</span>}
          <span className="ml-auto flex items-center gap-2">
            {l.pr && <span className="inline-flex items-center gap-0.5 font-mono text-[11px]" title={`Pull request ${l.pr}`}><GitPullRequest className="size-3.5" />{String(l.pr)}</span>}
            {l.commit && <GitCommitHorizontal className="size-3.5" aria-label={`commit ${l.commit}`} />}
            {l.branch && !l.pr && <GitBranch className="size-3.5" aria-label={`branch ${l.branch}`} />}
          </span>
        </div>
      )}
    </div>
  )
})
