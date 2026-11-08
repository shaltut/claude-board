import { CalendarClock, Columns3, History, ListOrdered, Plus, Layers } from 'lucide-react'
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { useProjects, useTasks } from '@/lib/api'
import { go, type View } from '@/lib/route'
import { ProjectDot, StatusDot, TaskId } from './Chips'

const VIEWS: { view: View; label: string; icon: typeof History }[] = [
  { view: 'today', label: 'Today', icon: CalendarClock },
  { view: 'board', label: 'Board', icon: Columns3 },
  { view: 'backlog', label: 'Backlog', icon: ListOrdered },
  { view: 'history', label: 'History', icon: History },
]

export function CommandMenu({ open, onOpenChange, onNewTask }: { open: boolean; onOpenChange: (o: boolean) => void; onNewTask: () => void }) {
  const { data: projects = [] } = useProjects()
  const { data: tasks = [] } = useTasks()
  const run = (fn: () => void) => { onOpenChange(false); fn() }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Jump to" description="Find a task, project or view" className="sm:max-w-xl">
      <Command>
        <CommandInput placeholder="Task title or #id, project, view…" />
        <CommandList className="max-h-[60vh]">
          <CommandEmpty>Nothing matches. Try a task number like #12.</CommandEmpty>
          <CommandGroup heading="Actions">
            <CommandItem onSelect={() => run(onNewTask)}><Plus /> New task</CommandItem>
          </CommandGroup>
          <CommandGroup heading="Tasks">
            {tasks.map((t) => (
              <CommandItem key={t.id} value={`#${t.id} ${t.title} ${t.project}`} onSelect={() => run(() => go({ task: t.id }))}>
                <StatusDot status={t.status} />
                <TaskId id={t.id} />
                <span className="truncate">{t.title}</span>
                <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground">{t.project}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Projects">
            <CommandItem value="all projects" onSelect={() => run(() => go({ project: undefined }))}><Layers /> All projects</CommandItem>
            {projects.map((p) => (
              <CommandItem key={p.slug} value={`project ${p.slug} ${p.name}`} onSelect={() => run(() => go({ project: p.slug }))}>
                <ProjectDot slug={p.slug} /> {p.name}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Go to">
            {VIEWS.map(({ view, label, icon: Icon }) => (
              <CommandItem key={view} value={`go ${label}`} onSelect={() => run(() => go({ view, task: undefined }))}>
                <Icon /> {label}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
