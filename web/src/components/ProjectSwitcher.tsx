import { useState } from 'react'
import { Check, ChevronsUpDown, Layers } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { useProjects } from '@/lib/api'
import { go } from '@/lib/route'
import { ProjectDot } from './Chips'

export function ProjectSwitcher({ project }: { project?: string }) {
  const [open, setOpen] = useState(false)
  const { data: projects = [] } = useProjects()
  const current = projects.find((p) => p.slug === project)
  const pick = (slug?: string) => { go({ project: slug, task: undefined }); setOpen(false) }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="inline-flex h-8 max-w-56 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-sm font-medium transition-colors hover:bg-raised aria-expanded:bg-raised sm:flex-none lg:min-w-40">
        {current ? <ProjectDot slug={current.slug} /> : <Layers className="size-3.5 text-muted-foreground" />}
        <span className="truncate">{current?.name ?? 'All projects'}</span>
        <ChevronsUpDown className="ml-auto size-3.5 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Find a project" />
          <CommandList>
            <CommandEmpty>No project with that name.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="__all" onSelect={() => pick(undefined)}>
                <Layers className="size-3.5" /> All projects
                {!project && <Check className="ml-auto size-3.5" />}
              </CommandItem>
              {projects.map((p) => (
                <CommandItem key={p.slug} value={`${p.slug} ${p.name}`} onSelect={() => pick(p.slug)}>
                  <ProjectDot slug={p.slug} />
                  <span className="truncate">{p.name}</span>
                  <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                    {p.question_count > 0 && <span className="flex items-center gap-1 font-semibold text-lamp tabular-nums" title={`${p.question_count} waiting on you`}><span className="lamp size-1.5" />{p.question_count}</span>}
                    <span className="tabular-nums" title={`${p.open_count} open tasks`}>
                    {p.open_count}</span>
                    {project === p.slug && <Check className="size-3.5 text-foreground" />}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
