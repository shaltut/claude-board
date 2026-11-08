import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { get, type User } from '@/lib/api'
import { Guest } from '@/views/Guest'
import { useLive } from '@/lib/live'
import { go, useRoute, VIEWS } from '@/lib/route'
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

const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
}

type Who = { role: 'local' } | { role: 'guest'; user: User } | { role: 'anonymous' }

/** The full board only on this machine; a guest link gets the guest page; anyone else gets nothing. */
export function Gate() {
  const { data } = useQuery({ queryKey: ['whoami'], queryFn: () => get<Who>('/api/whoami'), staleTime: Infinity })
  if (!data) return null
  if (data.role === 'local') return <App />
  if (data.role === 'guest') return <GuestLive user={data.user} />
  return (
    <main className="mx-auto max-w-md px-4 py-20 text-center">
      <h1 className="text-lg font-semibold">Claude Board</h1>
      <p className="mt-2 text-sm text-muted-foreground">Open the personal link Ahmed sent you to see your questions.</p>
    </main>
  )
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
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return
      const i = Number(e.key) - 1
      if (i >= 0 && i < VIEWS.length) go({ view: VIEWS[i], task: undefined, actor: undefined, huddle: undefined })
      else if (e.key === 'c') { e.preventDefault(); setNewTask(true) }
      else if (e.key === '/') { e.preventDefault(); setMenu(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const View = { today: Today, questions: Today, board: Board, backlog: Backlog, sessions: Sessions, huddles: Huddles, history: History }[route.view]

  return (
    <div className="min-h-dvh">
      <TopBar route={route} live={live} onSearch={() => setMenu(true)} />
      <main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
        {route.tag && (route.view === 'board' || route.view === 'backlog') && (
          <div className="mb-4 flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Showing</span>
            <span className="rounded-full border px-2 py-0.5 font-medium">#{route.tag}</span>
            <button onClick={() => go({ tag: undefined })} className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Show all tags
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
