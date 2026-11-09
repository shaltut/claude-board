import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { get, type Task, type User } from '@/lib/api'
import { Guest } from '@/views/Guest'
import { Login } from '@/views/Login'
import { useLive } from '@/lib/live'
import { go, useRoute, VIEWS } from '@/lib/route'
import { shortcutsOff } from '@/lib/keys'
import { TopBar } from '@/components/TopBar'
import { CommandMenu } from '@/components/CommandMenu'
import { NewTask } from '@/components/NewTask'
import { TaskPanel } from '@/components/TaskPanel'
import { Today } from '@/views/Today'
import { Board } from '@/views/Board'
import { Backlog } from '@/views/Backlog'
import { History } from '@/views/History'
import { Sessions } from '@/views/Sessions'
import { Huddles } from '@/views/Huddles'
import { People } from '@/views/People'
import { TagChip, TypeChip } from '@/components/Chips'


type Who = { role: 'local' } | { role: 'guest'; user: User } | { role: 'anonymous' }

/** The full board only on this machine; a signed-in guest gets the guest page; anyone else gets the login page. */
export function Gate() {
  const { data } = useQuery({ queryKey: ['whoami'], queryFn: () => get<Who>('/api/whoami'), staleTime: Infinity })
  if (!data) return null
  if (data.role === 'local') return <App />
  if (data.role === 'guest') {
    if (location.pathname === '/login') history.replaceState(null, '', '/')
    return <GuestLive user={data.user} />
  }
  return <Login />
}

function GuestLive({ user }: { user: User }) {
  useLive()
  return <Guest user={user} />
}

export default function App() {
  const route = useRoute()
  const live = useLive()
  const [menu, setMenu] = useState(false)
  const [newTask, setNewTask] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setMenu((m) => !m); return }
      if (shortcutsOff(e.target as Element | null) || e.ctrlKey || e.metaKey || e.altKey) return
      const i = Number(e.key) - 1
      if (i >= 0 && i < VIEWS.length) go({ view: VIEWS[i], task: undefined, actor: undefined, huddle: undefined })
      else if (e.key === 'c') { e.preventDefault(); setNewTask(true) }
      else if (e.key === '/') { e.preventDefault(); setMenu(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const View = { today: Today, questions: Today, board: Board, backlog: Backlog, sessions: Sessions, huddles: Huddles, history: History, people: People }[route.view]

  return (
    <div className="min-h-dvh">
      <button onClick={() => document.getElementById('main')?.focus()}
        className="sr-only z-50 rounded-md bg-foreground px-3 py-2 text-sm text-background focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Skip to content
      </button>
      <TopBar route={route} live={live} onSearch={() => setMenu(true)} />
      <main id="main" tabIndex={-1} className="outline-none mx-auto max-w-[1600px] px-4 pt-6 pb-16 sm:px-6 lg:pt-8">
        {(route.tag || route.type) && (route.view === 'board' || route.view === 'backlog') && (
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm" role="status">
            <span className="text-muted-foreground">Only</span>
            {route.type && <TypeChip type={route.type as Task['type']} active />}
            {route.tag && <><span className="text-muted-foreground">{route.type ? 'tagged' : 'tasks tagged'}</span><TagChip tag={route.tag} active /></>}
            <button onClick={() => go({ tag: undefined, type: undefined })} className="rounded-md px-1.5 py-0.5 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Show all
            </button>
          </div>
        )}
        <View route={route} />
      </main>
      <CommandMenu open={menu} onOpenChange={setMenu} onNewTask={() => setNewTask(true)} />
      <NewTask open={newTask} onOpenChange={setNewTask} project={route.project} />
      <TaskPanel id={route.task} />
    </div>
  )
}
