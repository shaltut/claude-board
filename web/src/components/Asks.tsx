import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CornerUpRight, MessageSquareQuote, X } from 'lucide-react'
import { toast } from 'sonner'
import { rpc, useAsks } from '@/lib/api'
import { defaultRecipient, type Ask } from '@/lib/asks'
import { ago, clock } from '@/lib/format'
import { go } from '@/lib/route'
import { cn } from '@/lib/utils'
import { useSessions, type SessionRow } from '@/views/Sessions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ActorChip, ProjectChip, TaskId } from './Chips'

/** Ahmed's asks (#936): ask one session from here; each ask is a thread its replies land in. */
export function Asks({ project }: { project?: string }) {
  const { data: asks = [] } = useAsks(project)
  const { data: sessions = [] } = useSessions()
  return (
    <section aria-labelledby="asks" className="mt-10">
      <h2 id="asks" className="flex items-center gap-2 text-base font-semibold">
        <MessageSquareQuote className="size-4 text-muted-foreground" aria-hidden /> Asks
      </h2>
      <p className="text-xs text-muted-foreground">Ask a session; its replies land here, not in its terminal.</p>
      <AskBox project={project} sessions={sessions} />
      {asks.length > 0 && <ul className="mt-4 grid gap-3">{asks.map((a) => <Thread key={a.id} a={a} sessions={sessions} />)}</ul>}
    </section>
  )
}

/** Live sessions to pick from (any project), plus `keep` (the default or current recipient) even if its relay is off. */
function SessionSelect({ value, onChange, sessions, keep, label, placeholder }: {
  value: string; onChange: (v: string) => void; sessions: SessionRow[]; keep?: string; label: string; placeholder: string
}) {
  const live = sessions.filter((s) => s.live || s.actor === keep)
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}
      className="h-8 min-w-0 rounded-md border border-input bg-card px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
      <option value="">{placeholder}</option>
      {live.map((s) => (
        <option key={s.actor} value={s.actor}>{s.actor}{s.project ? ` · ${s.project}` : ''}{s.live ? '' : ' (no relay)'}</option>
      ))}
    </select>
  )
}

function AskBox({ project, sessions }: { project?: string; sessions: SessionRow[] }) {
  const qc = useQueryClient()
  const fallback = defaultRecipient(sessions, project)
  const [picked, setPicked] = useState<string | null>(null) // null: follow the default as sessions come and go
  const [text, setText] = useState('')
  const [task, setTask] = useState('')
  const [busy, setBusy] = useState(false)
  const to = picked ?? fallback

  async function send() {
    if (!to || !text.trim() || busy) return
    setBusy(true)
    try {
      const id = await rpc<number>('ask_open', { to_actor: to, body: text, task: task.replace(/^#/, '').trim() || null, project: project ?? null })
      toast.success(`A${id} sent to ${to}`)
      setText(''); setTask('')
      qc.invalidateQueries({ queryKey: ['asks'] })
    } catch (e: any) {
      toast.error('Could not send the ask', { description: e.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="mt-3 grid gap-2 rounded-lg border bg-card p-3" onSubmit={(e) => { e.preventDefault(); send() }}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Ask</span>
        <SessionSelect value={to} onChange={setPicked} sessions={sessions} keep={fallback} label="Session to ask" placeholder="pick a session…" />
        <Input value={task} onChange={(e) => setTask(e.target.value)} placeholder="task # (optional)" aria-label="Task number (optional)"
          inputMode="numeric" className="h-8 w-36" />
      </div>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="What do you want to know or have done?" aria-label="Your ask"
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() } }} />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{to ? <>Goes to <span className="font-medium text-foreground">{to}</span> as a line it must answer with <code className="font-mono">cb reply</code>.</> : 'Pick a session to ask.'}</span>
        <Button type="submit" size="sm" disabled={!to || !text.trim() || busy}>Send ask</Button>
      </div>
    </form>
  )
}

const STATE: Record<Ask['state'], { label: string; tone: string }> = {
  sent: { label: 'sent', tone: 'text-muted-foreground' },
  seen: { label: 'seen', tone: 'text-foreground' },
  replied: { label: 'replied', tone: 'text-clear' },
  done: { label: 'done', tone: 'text-st-done' },
}

function Thread({ a, sessions }: { a: Ask; sessions: SessionRow[] }) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const open = a.status === 'open'
  const lost = open && a.state === 'sent' && !a.live

  async function act(fn: string, args: Record<string, unknown>, done: string) {
    if (busy) return
    setBusy(true)
    try {
      await rpc(fn, { id: String(a.id), ...args })
      toast.success(done)
      qc.invalidateQueries({ queryKey: ['asks'] })
      return true
    } catch (e: any) {
      toast.error(`A${a.id}: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className={cn('rounded-lg border bg-card px-4 py-3', !open && 'bg-card/60')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="callsign text-[13px] text-foreground">A{a.id}</span>
        <span className="inline-flex items-center gap-1">to <ActorChip actor={a.to_actor} /></span>
        {a.project && <ProjectChip slug={a.project} />}
        {a.task_id && (
          <button type="button" onClick={() => go({ task: a.task_id! })} className="hover:text-foreground"><TaskId id={a.task_id} /></button>
        )}
        <span className="tabular-nums">{ago(a.created_at)}</span>
        <span className="ml-auto flex items-center gap-2">
          {a.late && <span className="rounded bg-lamp/15 px-1.5 font-semibold text-lamp">late</span>}
          <span className={cn('font-medium', STATE[a.state].tone)}>{STATE[a.state].label}</span>
        </span>
      </div>
      {lost && <p className="mt-2 text-xs font-medium text-st-blocked">not delivered: no session (its relay is off). Re-route it below.</p>}

      <ol className="mt-2 grid gap-1.5">
        {a.lines.map((l) => {
          const mine = l.actor === 'ahmed'
          return (
            <li key={l.id} className={cn('grid grid-cols-[3rem_minmax(0,1fr)] gap-2 text-sm', !mine && 'border-l-2 border-clear/60 pl-2')}>
              <span className="pt-px text-xs text-muted-foreground tabular-nums">{clock(l.at)}</span>
              <p className="min-w-0 whitespace-pre-wrap text-pretty break-words">
                <span className="mr-1.5 text-xs font-medium text-muted-foreground">{mine ? 'You' : l.actor}{l.done ? ' (done)' : ''}</span>
                {l.action === 'close' ? <span className="text-muted-foreground">closed the ask</span>
                  : l.action === 'reroute' ? <span className="text-muted-foreground">{l.text}</span> : l.text}
              </p>
            </li>
          )
        })}
      </ol>

      {open && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <form className="flex min-w-60 flex-1 gap-2" onSubmit={async (e) => { e.preventDefault(); if (text.trim() && await act('ask_say', { message: text }, `Added to A${a.id}`)) setText('') }}>
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Write in the thread…" aria-label={`Write in A${a.id}`} className="h-8" />
            <Button type="submit" size="sm" variant="outline" disabled={!text.trim() || busy}>Send</Button>
          </form>
          <div className="flex items-center gap-2">
            <SessionSelect value={to} onChange={setTo} sessions={sessions.filter((s) => s.actor !== a.to_actor)} label={`Re-route A${a.id} to`} placeholder="re-route to…" />
            <Button size="sm" variant="outline" disabled={!to || busy}
              onClick={async () => { if (await act('ask_reroute', { to_actor: to }, `A${a.id} re-routed to ${to}`)) setTo('') }}>
              <CornerUpRight className="size-3.5" /> Re-route
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act('ask_close', {}, `A${a.id} closed`)}>
              <X className="size-3.5" /> Close
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}
