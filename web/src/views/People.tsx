import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Copy, KeyRound, UserPlus, UserX } from 'lucide-react'
import { get, rpc, type Task } from '@/lib/api'
import { ago } from '@/lib/format'
import { go, type Route } from '@/lib/route'
import { cn } from '@/lib/utils'
import { Priority, ProjectChip, StatusDot, TaskId } from '@/components/Chips'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

interface Person {
  name: string; display: string; token: string; created_at: string; last_active: string | null
  questions: { id: number; project: string; body: string; blocking: boolean; created_at: string }[]
  tasks: { id: number; project: string; title: string; status: Task['status']; priority: Task['priority'] }[]
}

// Local only: the server refuses /api/people to anything but this PC, since it carries the link tokens.
const usePeople = () => useQuery({ queryKey: ['people'], queryFn: () => get<{ public_url: string | null; people: Person[] }>('/api/people') })
const linkOf = (base: string, token: string) => `${base}/?u=${token}`
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** false when the clipboard refused: the caller then shows the whole link so it can be copied by hand. */
async function copy(link: string, who: string) {
  try { await navigator.clipboard.writeText(link); toast.success(`Copied ${who}'s link`); return true }
  catch { toast.error('Could not copy', { description: 'Select the link and copy it by hand.' }); return false }
}

export function People(_: { route: Route }) {
  const [adding, setAdding] = useState(false)
  const { data, isLoading } = usePeople()
  const people = data?.people ?? []
  const base = data?.public_url ?? location.origin
  const waiting = people.reduce((n, p) => n + p.questions.length, 0)

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.015em]">People</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            People who answer questions through a private link.
            {people.length > 0 && ` ${plural(people.length, 'person', 'people')}, ${plural(waiting, 'question')} waiting on them.`}
          </p>
        </div>
        <Button className="ml-auto" onClick={() => setAdding(true)}><UserPlus /> Add person</Button>
      </header>
      <TunnelNote publicUrl={data?.public_url ?? null} loaded={!!data} />
      <AddPerson open={adding} onOpenChange={setAdding} base={base} people={people} />

      {isLoading ? <p className="text-sm text-muted-foreground">Loading people…</p>
        : people.length === 0 ? (
          <div className="rounded-lg border border-dashed px-6 py-10 text-center">
            <p className="font-medium">No one yet.</p>
            <p className="mx-auto mt-1 max-w-[60ch] text-sm text-muted-foreground text-pretty">
              Add someone who should answer some questions instead of you, like a product owner. They get a private link,
              and see only the questions and tasks you hand them with the <strong className="font-medium text-foreground">For</strong> picker on a question.
            </p>
          </div>
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
            {people.map((p) => <PersonCard key={p.name} p={p} base={base} />)}
          </ul>
        )}
    </div>
  )
}

function TunnelNote({ publicUrl, loaded }: { publicUrl: string | null; loaded: boolean }) {
  if (!loaded) return null
  return (
    <p className="mb-5 max-w-[80ch] text-[13px] text-muted-foreground text-pretty">
      A link works only from outside this PC, through the board's tunnel. Opened here, it shows your own board.
      {publicUrl ? <> Links point at <span className="font-mono text-xs text-foreground">{publicUrl}</span>.</>
        : <> <span className="font-medium text-foreground">PUBLIC_URL isn't set</span>, so links point at this PC: set it in the board's <code className="font-mono text-xs">.env</code> (see docs/users.md).</>}
    </p>
  )
}

/** The link, readable and selectable, with a Copy button. Shown once right after it is made. */
function LinkBox({ link, who }: { link: string; who: string }) {
  return (
    <div className="flex items-center gap-2">
      <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label={`${who}'s link`} className="h-8 font-mono text-xs" spellCheck={false} />
      <Button onClick={() => copy(link, who)}><Copy /> Copy</Button>
    </div>
  )
}

function PersonCard({ p, base }: { p: Person; base: string }) {
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState<'rotate' | 'remove' | null>(null)
  // The whole link, shown after a new link is made or when the clipboard refused a copy.
  const [shown, setShown] = useState<{ link: string; why: 'new' | 'copy' } | null>(null)
  const [busy, setBusy] = useState(false)
  const link = linkOf(base, p.token)
  const holding = p.questions.filter((q) => q.blocking).length
  const working = p.tasks.filter((t) => t.status === 'in_progress').length

  async function act(kind: 'rotate' | 'remove') {
    setBusy(true)
    try {
      if (kind === 'rotate') {
        // the token the rotate returned, not the list's: that one is the old, dead link until the refetch lands
        const token = await rpc<string>('user_rotate', { name: p.name })
        await qc.invalidateQueries()
        setShown({ link: linkOf(base, token), why: 'new' })
        toast.success(`New link for ${p.display}`, { description: 'The old one no longer works. Send this one privately.' })
      } else {
        const r = await rpc<{ questions: number; tasks: number }>('user_remove', { name: p.name })
        toast.success(`Removed ${p.display}`, { description: `${plural(r.questions, 'question')} came back to you, ${plural(r.tasks, 'task')} unassigned.` })
      }
      setConfirm(null)
      await qc.invalidateQueries()
    } catch (e: any) { toast.error(e.message) }
    finally { setBusy(false) }
  }

  return (
    <li className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0">
          <h2 className="flex items-baseline gap-2">
            <span className="truncate text-[20px] leading-tight font-semibold tracking-[-0.01em]">{p.display}</span>
            <span className="font-mono text-xs text-muted-foreground" translate="no">{p.name}</span>
          </h2>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
            {p.questions.length > 0 && <span className="size-2 shrink-0 rounded-full border-2 border-muted-foreground/60" aria-hidden title="Waiting on someone else" />}
            {p.questions.length + p.tasks.length === 0 ? `Nothing waiting on ${p.display}.` : <span>
              {p.questions.length > 0 && <>{plural(p.questions.length, 'question')} waiting{holding > 0 && <>, <span className="font-medium text-foreground">{holding} holding work</span></>}</>}
              {p.questions.length > 0 && p.tasks.length > 0 && '; '}
              {p.tasks.length > 0 && plural(p.tasks.length, 'task')}
            </span>}
          </p>
        </div>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums" title={p.last_active ? new Date(p.last_active).toLocaleString() : undefined}>
          {p.last_active ? `last heard ${ago(p.last_active)}` : 'not heard from yet'}
        </span>
      </div>

      {(p.questions.length > 0 || p.tasks.length > 0) && (
        <ul className="space-y-1.5 border-t pt-3 text-sm">
          {p.questions.map((q) => (
            <li key={`q${q.id}`} className="flex items-center gap-2">
              <span className="callsign w-9 shrink-0 text-[12px] text-muted-foreground">Q{q.id}</span>
              <span className="line-clamp-1 min-w-0 flex-1">{q.body}</span>
              {q.blocking && <span className="shrink-0 text-xs text-muted-foreground">holds work</span>}
              <span className="hidden shrink-0 sm:inline"><ProjectChip slug={q.project} /></span>
            </li>
          ))}
          {p.tasks.map((t) => (
            <li key={`t${t.id}`}>
              <button onClick={() => go({ task: t.id })} className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded px-1 text-left hover:bg-raised/60">
                <StatusDot status={t.status} /><TaskId id={t.id} /><Priority p={t.priority} />
                <span className="line-clamp-1 min-w-0 flex-1">{t.title}</span>
                <span className="hidden shrink-0 sm:inline"><ProjectChip slug={t.project} /></span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-auto border-t pt-3">
        {confirm ? (
          <div role="group" aria-label={confirm === 'rotate' ? 'Confirm new link' : `Confirm removing ${p.display}`}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setConfirm(null) } }}
            className={cn('rounded-md p-3 text-sm', confirm === 'remove' ? 'bg-destructive/8' : 'bg-raised')}>
            <p className="text-pretty">
              {confirm === 'rotate'
                ? <>{p.display}'s current link stops working, also in a browser already signed in with it. You'll need to send the new one.</>
                : <>Remove {p.display}? Their link stops working.{' '}
                  {p.questions.length > 0 && <>Their {plural(p.questions.length, 'open question')} come{p.questions.length === 1 && 's'} back to you{holding > 0 && ', and work held on them stays held'}. </>}
                  {p.tasks.length > 0 && <>Their {plural(p.tasks.length, 'open task')} become{p.tasks.length === 1 && 's'} unassigned{working > 0 && ` (${working} in progress go${working === 1 ? 'es' : ''} back to Next)`}. </>}
                  Answers and notes they left stay.</>}
            </p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button size="sm" variant={confirm === 'remove' ? 'destructive' : 'default'} disabled={busy} onClick={() => act(confirm)}>
                {confirm === 'rotate' ? 'Make a new link' : `Remove ${p.display}`}
              </Button>
              <Button size="sm" variant="ghost" autoFocus onClick={() => setConfirm(null)}>Cancel</Button>
            </div>
          </div>
        ) : shown ? (
          <div className="grid gap-2">
            <p className="text-sm">{shown.why === 'new' ? `New link for ${p.display}. Send it privately:` : `Copying didn't work. Select ${p.display}'s link and copy it:`}</p>
            <LinkBox link={shown.link} who={p.display} />
            <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => setShown(null)}>Done</Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
            <code className="mr-auto min-w-0 basis-full truncate font-mono text-xs text-muted-foreground sm:basis-auto" title="The link is a secret: Copy it, don't show it">
              …/?u=••••{p.token.slice(-4)}
            </code>
            <Button size="sm" variant="secondary" onClick={async () => { if (!(await copy(link, p.display))) setShown({ link, why: 'copy' }) }}><Copy /> Copy link</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm('rotate')}><KeyRound /> New link</Button>
            <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => setConfirm('remove')}><UserX /> Remove</Button>
          </div>
        )}
      </div>
    </li>
  )
}

/** Name and display name; then the link, ready to copy. Adding a name that exists keeps their link and updates the display name. */
function AddPerson({ open, onOpenChange, base, people }: { open: boolean; onOpenChange: (o: boolean) => void; base: string; people: Person[] }) {
  const qc = useQueryClient()
  const [display, setDisplay] = useState('')
  const [name, setName] = useState('')
  const [made, setMade] = useState<{ display: string; link: string } | null>(null)
  const auto = display.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9_-]/g, '') ?? ''
  const handle = name || auto
  const existing = people.find((p) => p.name === handle)

  function close(o: boolean) {
    onOpenChange(o)
    if (!o) { setDisplay(''); setName(''); setMade(null) }
  }
  async function add(e: React.FormEvent) {
    e.preventDefault()
    try {
      const token = await rpc<string>('user_add', { name: handle, display })
      setMade({ display: display.trim() || handle, link: linkOf(base, token) })
      await qc.invalidateQueries()
    } catch (err: any) { toast.error(err.message) }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        {made ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{made.display}'s link</DialogTitle>
              <DialogDescription>Send it in a direct message, not a group chat: anyone with it can answer {made.display}'s questions. You can copy it again from People any time.</DialogDescription>
            </DialogHeader>
            <LinkBox link={made.link} who={made.display} />
            <DialogFooter><Button variant="ghost" onClick={() => close(false)}>Done</Button></DialogFooter>
          </div>
        ) : (
          <form onSubmit={add} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Add a person</DialogTitle>
              <DialogDescription>They answer the questions you hand them, through a private link.</DialogDescription>
            </DialogHeader>
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">Display name</span>
              <Input autoFocus required value={display} onChange={(e) => setDisplay(e.target.value)} placeholder="Omar Khaled…" />
            </label>
            <div className="grid gap-1.5 text-sm">
              <label htmlFor="person-name" className="font-medium">Name</label>
              <Input id="person-name" required value={handle} onChange={(e) => setName(e.target.value)} pattern="[a-z][a-z0-9_\-]*" spellCheck={false} autoCapitalize="off"
                placeholder="omar…" className="font-mono" aria-describedby="person-name-hint" />
              <span id="person-name-hint" className="text-xs text-muted-foreground">
                {existing ? <>{existing.display} already has this name: adding keeps their link and changes the display name.</>
                  : <>Lowercase. Sessions use it: <code className="font-mono">cb ask … --to {handle || 'omar'}</code></>}
              </span>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => close(false)}>Cancel</Button>
              <Button type="submit">{existing ? 'Update' : 'Add'}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
