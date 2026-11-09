import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CornerDownLeft, ListPlus, Plus } from 'lucide-react'
import { get, qs, rpc, useProjects } from '@/lib/api'
import { ago, clock, lineAuthor, splitActor } from '@/lib/format'
import { go, type Route } from '@/lib/route'
import { cn } from '@/lib/utils'
import { ActorChip, projectHue, ProjectChip, TaskId } from '@/components/Chips'
import { NewTask } from '@/components/NewTask'
import { LiveDot, type SessionRow } from '@/views/Sessions'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'

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
      <header className="mb-6 flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.015em]">Huddles</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Talk a problem through with your sessions, then turn what's said into tasks.
            {data.length > 0 && ` ${open} open, ${data.length - open} closed this week.`}
          </p>
        </div>
        <Button className="ml-auto" onClick={() => setStarting(true)}><Plus /> New huddle</Button>
      </header>
      <NewHuddle key={route.project ?? ''} open={starting} onOpenChange={setStarting} project={route.project} />
      {isLoading ? <p className="text-sm text-muted-foreground">Loading huddles…</p>
        : data.length === 0 ? (
          <div className="rounded-lg border border-dashed px-6 py-10 text-center">
            <p className="font-medium">No huddles yet.</p>
            <p className="mx-auto mt-1 max-w-[60ch] text-sm text-muted-foreground text-pretty">
              Start one with <strong className="font-medium text-foreground">New huddle</strong>: pick the orchestrator or any sessions, talk it through, and turn the outcome into tasks.
              Sessions also open them among themselves (<code className="font-mono text-xs">cb huddle open</code>); you see every line here as it's said.
            </p>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
            <ul className="space-y-1.5" aria-label="Huddles">
              {data.map((h) => {
                const on = h.id === selected
                return (
                  <li key={h.id}>
                    <a href={`#/huddles?h=${h.id}`} onClick={(e) => { e.preventDefault(); go({ huddle: h.id }) }} aria-current={on ? 'true' : undefined}
                      className={cn('block rounded-lg border p-3 outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring',
                        on ? 'border-input bg-card shadow-[inset_3px_0_0_var(--foreground)]' : 'border-transparent hover:bg-card/70')}>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className={cn('size-2 rounded-full', h.status === 'open' ? 'bg-clear shadow-[0_0_8px_var(--clear)]' : 'border border-muted-foreground/60')} />
                        <span>{h.status === 'open' ? 'Open' : 'Closed'}</span>
                        {!route.project && <ProjectChip slug={h.project} />}
                        <span className="ml-auto tabular-nums">{ago(h.last?.at ?? h.opened_at)}</span>
                      </div>
                      <p className={cn('mt-1.5 font-medium text-pretty', h.status === 'closed' && 'text-muted-foreground')}>{h.topic}</p>
                      <p className="mt-1 line-clamp-2 text-[13px] text-muted-foreground">
                        {h.summary ? `Outcome: ${h.summary}` : h.last ? `${name(h.last.actor)}: ${h.last.summary}` : ''}
                      </p>
                      <div className="mt-2 flex items-center gap-2">
                        <Faces members={h.members} />
                        <span className="text-xs text-muted-foreground tabular-nums">{h.messages} lines</span>
                      </div>
                    </a>
                  </li>
                )
              })}
            </ul>
            {selected != null && <ThreadView key={selected} id={selected} />}
          </div>
        )}
    </div>
  )
}

/** A callsign tile: the session's short name on a tint of its own hue. Ahmed's is the lamp: his voice in the room. */
function Tile({ actor, className }: { actor: string; className?: string }) {
  if (actor === 'ahmed') return (
    <span aria-hidden className={cn('callsign grid size-7 shrink-0 place-items-center rounded-md bg-(--lamp-glow) text-[12px] text-[#14201f]',
      'shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12),0_0_12px_color-mix(in_oklab,var(--lamp-glow)_45%,transparent)]', className)}>Ah</span>
  )
  const { who } = splitActor(actor)
  const h = projectHue(who)
  return (
    <span aria-hidden className={cn('callsign grid size-7 shrink-0 place-items-center rounded-md text-[12px] text-foreground', className)}
      style={{ background: `oklch(0.7 0.1 ${h} / 0.22)`, boxShadow: `inset 0 0 0 1px oklch(0.7 0.1 ${h} / 0.35)` }}>
      {who.slice(0, 2)}
    </span>
  )
}

function Faces({ members }: { members: string[] }) {
  return (
    <span className="flex -space-x-1.5">
      {members.slice(0, 5).map((m) => <Tile key={m} actor={m} className="size-5 rounded-[5px] text-[9.5px] ring-2 ring-background" />)}
    </span>
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
            <Input required list="cb-huddle-projects" value={proj} onChange={(e) => { setProj(e.target.value); setPicked(null) }} placeholder="project…" spellCheck={false} aria-label="Project" />
            <datalist id="cb-huddle-projects">{projects.map((p) => <option key={p.slug} value={p.slug} />)}</datalist>
            <Input value={task} onChange={(e) => setTask(e.target.value)} placeholder="task #, optional" inputMode="numeric" aria-label="Linked task" />
          </div>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 flex w-full items-baseline text-sm font-medium">
              With
              {members.length > 0 && <span className="ml-auto text-xs font-normal text-muted-foreground tabular-nums">{members.length} picked</span>}
            </legend>
            {!proj ? <p className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">Pick a project to see its sessions.</p>
              : mine.length === 0 ? <p className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">No sessions in {proj} yet.</p>
              : (
                <ul className="max-h-60 divide-y overflow-y-auto rounded-md border">
                  {mine.map((s) => {
                    const on = members.includes(s.actor)
                    return (
                      <li key={s.actor}>
                        <label className={cn('flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 transition-colors duration-150 hover:bg-raised/60', on && 'bg-raised/60')}>
                          <input type="checkbox" checked={on} onChange={() => toggle(s.actor)} className="size-4 shrink-0 accent-foreground" />
                          <Tile actor={s.actor} className="size-6 text-[10.5px]" />
                          <span className="grid min-w-0 flex-1 gap-0.5">
                            <span className="flex items-baseline gap-3">
                              <ActorChip actor={s.actor} />
                              <LiveDot s={s} />
                            </span>
                            {s.doing[0] && <span className="truncate text-xs text-muted-foreground">on <span className="callsign">#{s.doing[0].id}</span> {s.doing[0].title}</span>}
                          </span>
                        </label>
                      </li>
                    )
                  })}
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
    <section aria-labelledby="thread" className="overflow-hidden rounded-lg border bg-card">
      <header className="border-b p-4 sm:p-5">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          <h2 id="thread" className="min-w-0 flex-1 basis-64 text-lg leading-snug font-semibold tracking-[-0.01em] text-pretty">{h.topic}</h2>
          {live && closing === null && <Button size="sm" variant="outline" className="shrink-0" onClick={() => setClosing('')}>Close with outcome</Button>}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className={cn('flex items-center gap-1.5', live && 'text-foreground')}>
            <span className={cn('size-2 rounded-full', live ? 'bg-clear shadow-[0_0_8px_var(--clear)]' : 'border border-muted-foreground/60')} />
            {live ? 'Open' : `Closed ${ago(h.closed_at)}`}
          </span>
          <span className="callsign">Huddle {h.id}</span>
          {h.task_id && <button onClick={() => go({ task: h.task_id! })} className="-mx-1 rounded px-1 hover:bg-raised hover:text-foreground">on <TaskId id={h.task_id} className="text-current" /></button>}
          <span>opened by <ActorChip actor={h.opened_by} /> {ago(h.opened_at)}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5">{h.members.map((m) => <ActorChip key={m} actor={m} />)}</div>
        {live && closing !== null && (
          <form onSubmit={close} className="mt-4 grid gap-2 rounded-md border bg-background/60 p-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
            <Input autoFocus value={closing} onChange={(e) => setClosing(e.target.value)} placeholder="What was decided?" aria-label="Outcome"
              onKeyDown={(e) => { if (e.key === 'Escape') setClosing(null) }} />
            <Button type="submit" size="sm">Close huddle</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setClosing(null)}>Cancel</Button>
          </form>
        )}
      </header>
      <ol className="space-y-0.5 p-3 sm:p-4">
        {h.lines.map((l, i) => {
          if (l.action !== 'say') return (
            <li key={l.id} className="flex items-center gap-3 py-1.5 pl-10 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              <span><span className="tabular-nums">{clock(l.at)}</span> {name(l.actor)} {l.summary}</span>
              <span className="h-px flex-1 bg-border" />
            </li>
          )
          const prev = h.lines[i - 1]
          const cont = prev?.action === 'say' && prev.actor === l.actor
          const me = l.actor === 'ahmed'
          const next = h.lines[i + 1]
          const contNext = next?.action === 'say' && next.actor === l.actor
          return (
            <li key={l.id} data-from={me ? 'ahmed' : 'session'}
              className={cn('group relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 rounded-md px-1 py-1', !cont && 'mt-2',
                me ? 'bg-lamp-soft py-2 pr-2 pl-2 shadow-[inset_3px_0_0_var(--lamp)]' : 'hover:bg-raised/40',
                me && cont && '-mt-0.5 rounded-t-none pt-0.5', me && contNext && 'rounded-b-none pb-1')}>
              {cont ? <span /> : <Tile actor={l.actor} />}
              <div className="min-w-0">
                {!cont && (
                  <div className="flex min-h-6 items-baseline gap-2 pr-40 pointer-coarse:pr-0">
                    <ActorChip actor={l.actor} />
                    <time className="text-xs text-muted-foreground tabular-nums" dateTime={l.at}>{clock(l.at)}</time>
                  </div>
                )}
                <p className={cn('mt-0.5 max-w-[70ch] text-[14.5px] leading-relaxed whitespace-pre-wrap text-pretty', me && 'text-lamp-ink')}>{l.summary}</p>
                {/* Hover-revealed with a fine pointer; always there, under the line, on touch. */}
                <Button size="xs" variant="ghost" onClick={() => setDraft(l)} aria-label={`Create task from ${name(l.actor)}'s line at ${clock(l.at)}`}
                  className={cn('absolute top-1 right-1 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                    me ? 'bg-lamp-soft' : 'bg-card', 'pointer-coarse:static pointer-coarse:-ml-2 pointer-coarse:mt-0.5 pointer-coarse:bg-transparent pointer-coarse:opacity-100')}>
                  <ListPlus /> Create task from this
                </Button>
              </div>
            </li>
          )
        })}
      </ol>
      {live ? <Composer id={id} /> : h.summary && (
        <footer className="border-t bg-raised/50 p-5">
          <p className="text-xs font-medium text-muted-foreground">Outcome</p>
          <p className="mt-1 font-medium text-pretty">{h.summary}</p>
        </footer>
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
    <form onSubmit={(e) => { e.preventDefault(); send() }} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 border-t bg-background/40 p-3 sm:px-5 sm:py-4">
      <Tile actor="ahmed" className="mt-1" />
      <div className="min-w-0">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} aria-label="Message to the huddle"
          placeholder="Say something to the room…" className="resize-y bg-card"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }} />
        <div className="mt-2 flex items-center gap-3">
          <span className="hidden text-xs text-muted-foreground sm:inline"><Kbd>Enter</Kbd> sends, <Kbd>Shift Enter</Kbd> adds a line</span>
          <Button type="submit" size="sm" className="ml-auto" disabled={!text.trim() || sending}>Send <CornerDownLeft /></Button>
        </div>
      </div>
    </form>
  )
}
