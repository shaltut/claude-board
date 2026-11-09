import { CalendarClock, Columns3, History, ListOrdered, Plus, Layers, Radio, MessagesSquare } from 'lucide-react'
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command'
import { useProjects, useTasks } from '@/lib/api'
import { go, type View } from '@/lib/route'
import { ProjectDot, StatusDot, TaskId } from './Chips'

const VIEWS: { view: View; label: string; icon: typeof History }[] = [
  { view: 'today', label: 'Today', icon: CalendarClock },
  { view: 'board', label: 'Board', icon: Columns3 },
  { view: 'backlog', label: 'Backlog', icon: ListOrdered },
  { view: 'sessions', label: 'Sessions', icon: Radio },
  { view: 'huddles', label: 'Huddles', icon: MessagesSquare },
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
            <CommandItem onSelect={() => run(onNewTask)}><Plus /> New task<CommandShortcut>C</CommandShortcut></CommandItem>
          </CommandGroup>
          <CommandGroup heading="Tasks">
            {tasks.map((t) => (
              <CommandItem key={t.id} value={`#${t.id} ${t.title} ${t.project}`} onSelect={() => run(() => go({ task: t.id }))}>
                <StatusDot status={t.status} />
                <TaskId id={t.id} className="w-9 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{t.project}</span>
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
            {VIEWS.map(({ view, label, icon: Icon }, i) => (
              <CommandItem key={view} value={`go ${label}`} onSelect={() => run(() => go({ view, task: undefined, actor: undefined, huddle: undefined }))}>
                <Icon /> {label}<CommandShortcut>{i + 1}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
