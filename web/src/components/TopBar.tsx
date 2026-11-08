import { Moon, Search, Sun } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useQuestions } from '@/lib/api'
import { go, type Route, type View } from '@/lib/route'
import { useTheme } from '@/lib/theme'
import { Kbd } from '@/components/ui/kbd'
import { ProjectSwitcher } from './ProjectSwitcher'

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
  const { data: open = [] } = useQuestions(route.project, 'open')

  return (
    <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-4 px-4 sm:px-6">
        <a href="#/today" className="flex items-center gap-2 font-semibold tracking-tight" aria-label="Claude Board home">
          <Mark /> <span className="hidden sm:inline">Claude Board</span>
        </a>
        <ProjectSwitcher project={route.project} />
        <nav className="flex items-center gap-1 overflow-x-auto" aria-label="Views">
          {TABS.map((t) => {
            const active = route.view === t.view || (t.view === 'today' && route.view === 'questions')
            return (
              <button key={t.view} onClick={() => go({ view: t.view, task: undefined, actor: undefined, huddle: undefined })} title={`${t.label} (${t.key})`}
                className={cn('relative flex h-14 items-center gap-1.5 px-2.5 text-sm transition-colors',
                  active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                {t.label}
                {t.view === 'today' && open.length > 0 && (
                  <span className="rounded-full bg-dawn px-1.5 text-[11px] font-semibold leading-4 text-background">{open.length}</span>
                )}
                {active && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />}
              </button>
            )
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden items-center gap-1.5 text-xs text-muted-foreground md:flex"
            title={live === 'live' ? 'Updates arrive as Claude writes' : 'Lost the live connection, retrying'}>
            <span className={cn('size-1.5 rounded-full', live === 'live' ? 'bg-st-done' : 'animate-pulse bg-st-blocked')} />
            {live === 'live' ? 'Live' : 'Reconnecting'}
          </span>
          <button onClick={toggle} className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          <button onClick={onSearch}
            className="flex h-8 items-center gap-2 rounded-md border bg-card px-2.5 text-sm text-muted-foreground hover:text-foreground">
            <Search className="size-3.5" /> <span className="hidden lg:inline">Jump to</span> <Kbd>Ctrl K</Kbd>
          </button>
        </div>
      </div>
    </header>
  )
}

/** A half-lit circle: night above, dawn below. */
function Mark() {
  return (
    <svg viewBox="0 0 20 20" className="size-5" aria-hidden>
      <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeOpacity=".35" />
      <path d="M1.5 10a8.5 8.5 0 0 0 17 0z" fill="var(--dawn)" />
    </svg>
  )
}
