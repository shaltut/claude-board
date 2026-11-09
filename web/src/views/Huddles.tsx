import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ListPlus, Plus } from 'lucide-react'
import { get, qs, rpc, useProjects } from '@/lib/api'
import { ago, clock, lineAuthor, splitActor } from '@/lib/format'
import { go, type Route } from '@/lib/route'
import { cn } from '@/lib/utils'
import { ActorChip, ProjectChip, TaskId } from '@/components/Chips'
import { NewTask } from '@/components/NewTask'
import type { SessionRow } from '@/views/Sessions'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'

interface HuddleRow {
  id: number; project: string; topic: string; task_id: number | null; opened_by: string; status: 'open' | 'closed'
  summary: string | null; opened_at: string; closed_at: string | null; members: string[]; messages: number
  last: { actor: string; summary: string; at: string } | null
}
interface Line { id: number; at: string; actor: string; summary: string; action: 'open' | 'add' | 'say' | 'close' }
type Thread = Omit<HuddleRow, 'messages' | 'last'> & { lines: Line[] }

const name = (actor: string) => (actor === 'ahmed' ? 'Ahmed' : splitActor(actor).who)
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export function Huddles({ route }: { route: Route }) {
  const [starting, setStarting] = useState(false)
  const { data = [], isLoading } = useQuery({
    queryKey: ['huddles', route.project], queryFn: () => get<HuddleRow[]>(`/api/huddles${qs({ project: route.project })}`),
  })
  const selected = route.huddle ?? data.find((h) => h.status === 'open')?.id ?? data[0]?.id
  const open = data.filter((h) => h.status === 'open').length

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-baseline gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Huddles</h2>
        <span className="text-sm text-muted-foreground">
          Brainstorm with your sessions, then turn what's said into tasks.
          {data.length > 0 && ` ${open} open, ${data.length - open} closed this week.`}
        </span>
        <Button size="sm" className="ml-auto self-center" onClick={() => setStarting(true)}><Plus /> New huddle</Button>
      </div>
      <NewHuddle key={route.project ?? ''} open={starting} onOpenChange={setStarting} project={route.project} />
      {isLoading ? <p className="text-sm text-muted-foreground">Loading huddles…</p>
        : data.length === 0 ? (
          <div className="rounded-lg border border-dashed px-6 py-10 text-center">
            <p className="font-medium">No huddles yet.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Start one with <strong>New huddle</strong>: pick the orchestrator (or any sessions), talk it through, and turn the outcome into tasks.
              Sessions also open them among themselves (<code>cb huddle open</code>); you see every line here as it's said.
            </p>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
            <ul className="space-y-2" aria-label="Huddles">
              {data.map((h) => (
                <li key={h.id}>
                  <button onClick={() => go({ huddle: h.id })} aria-current={h.id === selected}
                    className={cn('w-full rounded-lg border bg-card p-3 text-left outline-none hover:border-ring/50 focus-visible:ring-2 focus-visible:ring-ring',
                      h.id === selected && 'border-ring', h.status === 'closed' && 'opacity-70')}>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className={cn('size-2 rounded-full', h.status === 'open' ? 'bg-st-done' : 'bg-muted-foreground/40')} />
                      <span>{h.status === 'open' ? 'Open' : 'Closed'}</span>
                      {!route.project && <ProjectChip slug={h.project} />}
                      <span className="ml-auto">{ago(h.last?.at ?? h.opened_at)}</span>
                    </div>
                    <p className="mt-1 font-medium text-pretty">{h.topic}</p>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {h.summary ? `Outcome: ${h.summary}` : h.last ? `${name(h.last.actor)}: ${h.last.summary}` : ''}
                    </p>
                    <p className="mt-1.5 text-xs text-muted-foreground">{h.members.map(name).join(', ')} · {h.messages} lines</p>
                  </button>
                </li>
              ))}
            </ul>
            {selected != null && <ThreadView key={selected} id={selected} />}
          </div>
        )}
    </div>
  )
}

/** Ahmed opens a huddle: topic, the project's sessions (orchestrator preselected, live first), optional task. */
function NewHuddle({ open, onOpenChange, project }: { open: boolean; onOpenChange: (o: boolean) => void; project?: string }) {
  const { data: projects = [] } = useProjects()
  const [proj, setProj] = useState(project ?? '')
  const [topic, setTopic] = useState('')
  const [task, setTask] = useState('')
  const [picked, setPicked] = useState<string[] | null>(null) // null = the default pick (orchestrator)
  const { data: sessions = [] } = useQuery({
    queryKey: ['sessions', proj], enabled: !!proj, queryFn: () => get<SessionRow[]>(`/api/sessions${qs({ project: proj })}`),
  })
  const mine = sessions.filter((s) => s.project === proj) // already live first; only bound sessions can join
  const orch = mine.find((s) => /^orch(@|$)/.test(s.actor))
  const members = picked ?? (orch ? [orch.actor] : [])
  const toggle = (a: string) => setPicked(members.includes(a) ? members.filter((m) => m !== a) : [...members, a])

  async function start(e: React.FormEvent) {
    e.preventDefault()
    try {
      const id = await rpc<number>('huddle_open', { topic, members, task: task.trim() || null, project: proj })
      onOpenChange(false)
      setTopic(''); setTask(''); setPicked(null)
      go({ view: 'huddles', huddle: id })
    } catch (err: any) { toast.error(err.message) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={start} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New huddle</DialogTitle>
            <DialogDescription>The sessions you pick hear that you opened it and reply here. Ask, discuss, decide.</DialogDescription>
          </DialogHeader>
          <Input autoFocus required value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What do you want to talk about?" aria-label="Topic" />
          <div className="grid grid-cols-2 gap-2">
            <Input required list="cb-huddle-projects" value={proj} onChange={(e) => { setProj(e.target.value); setPicked(null) }} placeholder="project" aria-label="Project" />
            <datalist id="cb-huddle-projects">{projects.map((p) => <option key={p.slug} value={p.slug} />)}</datalist>
            <Input value={task} onChange={(e) => setTask(e.target.value)} placeholder="task # (optional)" aria-label="Linked task" />
          </div>
          <fieldset className="grid gap-1">
            <legend className="mb-1 text-sm font-medium">With</legend>
            {!proj ? <p className="text-sm text-muted-foreground">Pick a project to see its sessions.</p>
              : mine.length === 0 ? <p className="text-sm text-muted-foreground">No sessions in {proj} yet.</p>
              : (
                <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                  {mine.map((s) => (
                    <li key={s.actor}>
                      <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted">
                        <input type="checkbox" checked={members.includes(s.actor)} onChange={() => toggle(s.actor)} className="accent-primary" />
                        <ActorChip actor={s.actor} />
                        <span className={cn('size-1.5 rounded-full', s.live ? 'bg-st-done' : 'bg-muted-foreground/40')} aria-hidden />
                        <span className="text-xs text-muted-foreground">{s.live ? 'live' : `seen ${ago(s.last_seen)}`}</span>
                        {s.doing[0] && <span className="ml-auto truncate text-xs text-muted-foreground">#{s.doing[0].id} {s.doing[0].title}</span>}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
          </fieldset>
          <DialogFooter><Button type="submit" disabled={!members.length}>Start huddle</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ThreadView({ id }: { id: number }) {
  const { data: h } = useQuery({ queryKey: ['huddle', id], queryFn: () => get<Thread>(`/api/huddles/${id}`) })
  const [draft, setDraft] = useState<Line | null>(null)
  const [closing, setClosing] = useState<string | null>(null)
  const qc = useQueryClient()
  if (!h) return <p className="text-sm text-muted-foreground">Loading…</p>
  const live = h.status === 'open'

  async function close(e: React.FormEvent) {
    e.preventDefault()
    try { await rpc('huddle_close', { id, summary: closing }); setClosing(null); await qc.invalidateQueries() }
    catch (err: any) { toast.error(err.message) }
  }
  // Posted as Ahmed, so it carries his authority in the relay: never repeat a session's words (or a title
  // taken from them) in it, only the task id and whose line it came from.
  const madeTask = (line: Line) => (tid: number) => live &&
    rpc('huddle_say', { id, message: `created #${tid} from ${lineAuthor(line.actor)}'s line at ${clock(line.at)}` }).catch((err) => toast.error(err.message))

  return (
    <section aria-labelledby="thread" className="rounded-lg border bg-card">
      <header className="border-b p-4">
        <div className="flex items-start gap-3">
          <h3 id="thread" className="text-lg font-semibold tracking-tight text-pretty">{h.topic}</h3>
          {live && closing === null && <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={() => setClosing('')}>Close with outcome</Button>}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>Huddle #{h.id}</span>
          {h.task_id && <button onClick={() => go({ task: h.task_id! })} className="hover:text-foreground"><TaskId id={h.task_id} /></button>}
          <span>opened by {name(h.opened_by)} {ago(h.opened_at)}</span>
          {!live && <span>· closed {ago(h.closed_at)}</span>}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">{h.members.map((m) => <ActorChip key={m} actor={m} />)}</div>
        {live && closing !== null && (
          <form onSubmit={close} className="mt-3 flex gap-2">
            <Input autoFocus value={closing} onChange={(e) => setClosing(e.target.value)} placeholder="What was decided?" aria-label="Outcome" />
            <Button type="submit" size="sm">Close huddle</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setClosing(null)}>Cancel</Button>
          </form>
        )}
      </header>
      <ol className="space-y-3 p-4">
        {h.lines.map((l) => l.action === 'say' ? (
          <li key={l.id} data-from={l.actor === 'ahmed' ? 'ahmed' : 'session'}
            className={cn('group text-sm', l.actor === 'ahmed' && 'rounded-md bg-dawn-soft px-3 py-2')}>
            <div className="flex items-baseline gap-2">
              <span className={cn('font-semibold', l.actor === 'ahmed' && 'text-dawn-ink')}>{name(l.actor)}</span>
              <time className="text-xs text-muted-foreground tabular-nums" dateTime={l.at}>{clock(l.at)}</time>
              <Button size="xs" variant="ghost" onClick={() => setDraft(l)}
                className="ml-auto text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100">
                <ListPlus /> Create task from this
              </Button>
            </div>
            <p className="mt-0.5 whitespace-pre-wrap text-pretty">{l.summary}</p>
          </li>
        ) : (
          <li key={l.id} className="text-xs text-muted-foreground">
            <span className="tabular-nums">{clock(l.at)}</span> {name(l.actor)} {l.summary}
          </li>
        ))}
      </ol>
      {live ? <Composer id={id} /> : h.summary && (
        <footer className="border-t p-4 text-sm"><span className="font-medium">Outcome:</span> {h.summary}</footer>
      )}
      {draft && (
        <NewTask key={draft.id} open onOpenChange={(o) => !o && setDraft(null)} project={h.project}
          initial={{ title: cut(draft.summary.split('\n')[0], 100), body: `${draft.summary}\n\nFrom huddle #${h.id} "${h.topic}" (${name(draft.actor)}, ${clock(draft.at)})` }}
          links={{ huddle: `#${h.id}` }} onCreated={madeTask(draft)} />
      )}
    </section>
  )
}

/** Ahmed's line into the huddle. Enter sends, Shift+Enter is a new line. */
function Composer({ id }: { id: number }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const qc = useQueryClient()
  async function send() {
    const message = text.trim()
    if (!message || sending) return
    setSending(true)
    try { await rpc('huddle_say', { id, message }); setText(''); await qc.invalidateQueries({ queryKey: ['huddle', id] }) }
    catch (err: any) { toast.error(err.message) }
    finally { setSending(false) }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); send() }} className="border-t p-3">
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} aria-label="Message to the huddle"
        placeholder="Say something… (Enter sends, Shift+Enter for a new line)"
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }} />
      <div className="mt-2 flex justify-end"><Button type="submit" size="sm" disabled={!text.trim() || sending}>Send</Button></div>
    </form>
  )
}
