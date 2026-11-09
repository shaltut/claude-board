import { Moon, Search, Sun } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useQuestions } from '@/lib/api'
import { go, href, type Route, type View } from '@/lib/route'
import { useTheme } from '@/lib/theme'
import { Kbd } from '@/components/ui/kbd'
import { ProjectSwitcher } from './ProjectSwitcher'
import { Mark, useTabLamp } from './Mark'

const TABS: { view: View; label: string; key: string }[] = [
  { view: 'today', label: 'Today', key: '1' },
  { view: 'board', label: 'Board', key: '2' },
  { view: 'backlog', label: 'Backlog', key: '3' },
  { view: 'sessions', label: 'Sessions', key: '4' },
  { view: 'huddles', label: 'Huddles', key: '5' },
  { view: 'history', label: 'History', key: '6' },
]

export function TopBar({ route, live, onSearch }: { route: Route; live: 'live' | 'reconnecting'; onSearch: () => void }) {
  const { theme, toggle } = useTheme()
  const { data: all = [] } = useQuestions(route.project, 'open')
  const open = all.filter((q) => !q.assigned_to) // questions handed to Omar/Iman aren't waiting on Ahmed
  useTabLamp(open.length)

  return (
    <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur-md backdrop-saturate-150">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-0 px-4 sm:px-6 lg:flex-nowrap">
        <a href="#/today" className="flex h-13 items-center gap-2.5 rounded-md" aria-label="Claude Board, go to Today">
          <Mark lit={open.length > 0} />
          <span className="hidden text-[15px] font-semibold tracking-tight [font-stretch:88%] sm:inline">Claude Board</span>
        </a>
        <span aria-hidden className="hidden h-5 w-px bg-border sm:block" />
        <ProjectSwitcher project={route.project} />

        <nav className="order-last -mx-4 flex w-[calc(100%+2rem)] items-center gap-0.5 overflow-x-auto border-t px-3 py-1.5 [scrollbar-width:none] sm:-mx-6 sm:w-[calc(100%+3rem)] sm:px-5 lg:order-none lg:mx-2 lg:w-auto lg:border-t-0 lg:p-0" aria-label="Views">
          {TABS.map((t) => {
            const active = route.view === t.view || (t.view === 'today' && route.view === 'questions')
            return (
              <a key={t.view} href={href({ view: t.view, project: route.project, tag: route.tag })}
                onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); go({ view: t.view, task: undefined, actor: undefined, huddle: undefined }) }}
                aria-current={active ? 'page' : undefined} title={`${t.label} (${t.key})`}
                className={cn('group flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-sm transition-colors duration-150',
                  active ? 'bg-raised font-medium text-foreground' : 'text-muted-foreground hover:bg-raised/60 hover:text-foreground')}>
                <span aria-hidden className={cn('callsign hidden w-2 text-[11px] text-muted-foreground/70 xl:inline', active && 'text-muted-foreground')}>{t.key}</span>
                {t.label}
                {t.view === 'today' && open.length > 0 && (
                  <span className="flex items-center gap-1.5 text-[12px] font-semibold text-lamp tabular-nums">
                    <span className="lamp size-1.5" />{open.length}
                    <span className="sr-only">waiting on you</span>
                  </span>
                )}
              </a>
            )
          })}
        </nav>

        <div className="ml-auto flex items-center gap-1.5">
          <span role="status" className="flex items-center gap-1.5 px-1.5 text-xs text-muted-foreground"
            title={live === 'live' ? 'Updates arrive as Claude writes' : 'Lost the live connection, retrying'}>
            <span className={cn('size-1.5 rounded-full', live === 'live' ? 'bg-clear shadow-[0_0_8px_var(--clear)]' : 'animate-pulse bg-st-blocked')} />
            <span className="hidden md:inline">{live === 'live' ? 'Live' : 'Reconnecting…'}</span>
          </span>
          <button onClick={toggle} className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-raised hover:text-foreground"
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          <button onClick={onSearch} aria-label="Jump to a task, project or view"
            className="flex h-8 items-center gap-2 rounded-md border bg-card px-2 text-sm text-muted-foreground transition-colors hover:border-input hover:text-foreground sm:px-2.5">
            <Search className="size-3.5" /> <span className="hidden lg:inline">Jump to…</span> <Kbd className="hidden sm:inline-flex">Ctrl&nbsp;K</Kbd>
          </button>
        </div>
      </div>
    </header>
  )
}
