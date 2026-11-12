import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Copy, KeyRound, LogOut, ShieldCheck, UserPlus, UserX, X } from 'lucide-react'
import { get, rpc, useProjects, type Task } from '@/lib/api'
import { ago } from '@/lib/format'
import { go, type Route } from '@/lib/route'
import { cn } from '@/lib/utils'
import { Priority, ProjectChip, ProjectDot, StatusDot, TaskId } from '@/components/Chips'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useWho } from '@/components/Account'

/** Who is looking at the Users page: an admin by name, or Ahmed on his PC's own dashboard (no sign-in there). */
function useViewer() {
  const { data: who } = useWho()
  return who?.role === 'admin' ? who.user.name : 'ahmed'
}
/** Another admin's password and sign-in are the owner's to change (the server refuses the rest); a member's, any admin's. */
const managesSignIn = (me: string, p: Person) => p.role !== 'admin' || me === 'ahmed' || me === p.name

interface Person {
  // token: a member's link; null for an admin (admins sign in by password, and the token is their cookie)
  name: string; display: string; role: 'admin' | 'member'; token: string | null; created_at: string; last_active: string | null; projects: string[]; has_password: boolean
  questions: { id: number; project: string; body: string; blocking: boolean; created_at: string }[]
  tasks: { id: number; project: string; title: string; status: Task['status']; priority: Task['priority'] }[]
}

// Admins only (and only the page itself): it carries members' link tokens.
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
  const admins = people.filter((p) => p.role === 'admin').length

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.015em]">Users</h1>
          <p className="mt-1 max-w-[80ch] text-sm text-muted-foreground text-pretty">
            Everyone who signs in. Admins get the whole board and sign in with a password; members see only the questions and
            tasks handed to them, signing in with a password or a private link.
            {people.length > 0 && ` ${plural(admins, 'admin')}, ${plural(people.length - admins, 'member')}, ${plural(waiting, 'question')} waiting on members.`}
          </p>
        </div>
        <Button className="ml-auto" onClick={() => setAdding(true)}><UserPlus /> Add user</Button>
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
  const link = p.token ? linkOf(base, p.token) : ''
  const owner = p.name === 'ahmed'
  const me = useViewer()
  const holding = p.questions.filter((q) => q.blocking).length
  const working = p.tasks.filter((t) => t.status === 'in_progress').length

  async function act(kind: 'rotate' | 'remove') {
    setBusy(true)
    try {
      if (kind === 'rotate') {
        // the token the rotate returned, not the list's: that one is the old, dead link until the refetch lands.
        // An admin has no link: for them it only ends every sign-in (null comes back).
        const token = await rpc<string | null>('user_rotate', { name: p.name })
        await qc.invalidateQueries()
        if (token) {
          setShown({ link: linkOf(base, token), why: 'new' })
          toast.success(`New link for ${p.display}`, { description: 'The old one no longer works. Send this one privately.' })
        } else toast.success(`${p.display} is signed out everywhere`, { description: 'Their password still works.' })
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
            {p.role === 'admin' && <span className="inline-flex items-center gap-1 self-center rounded border px-1.5 text-[11px] text-muted-foreground"><ShieldCheck className="size-3" />admin</span>}
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

      <Access p={p} />

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
          <div role="group" aria-label={confirm === 'rotate' ? (p.token ? 'Confirm new link' : 'Confirm signing out everywhere') : `Confirm removing ${p.display}`}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setConfirm(null) } }}
            className={cn('rounded-md p-3 text-sm', confirm === 'remove' ? 'bg-destructive/8' : 'bg-raised')}>
            <p className="text-pretty">
              {confirm === 'rotate' && !p.token
                ? <>Every browser signed in as {p.display} is signed out{p.name === me && ', this one too'}. The password still works.</>
                : confirm === 'rotate'
                ? <>{p.display}'s current link stops working, and every browser signed in as {p.display} is signed out, by link or by password{p.has_password && '; the password itself still works'}. You'll need to send the new link.</>
                : <>Remove {p.display}? Their link stops working.{' '}
                  {p.questions.length > 0 && <>Their {plural(p.questions.length, 'open question')} come{p.questions.length === 1 && 's'} back to you{holding > 0 && ', and work held on them stays held'}. </>}
                  {p.tasks.length > 0 && <>Their {plural(p.tasks.length, 'open task')} become{p.tasks.length === 1 && 's'} unassigned{working > 0 && ` (${working} in progress go${working === 1 ? 'es' : ''} back to Next)`}. </>}
                  Answers and notes they left stay.</>}
            </p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button size="sm" variant={confirm === 'remove' ? 'destructive' : 'default'} disabled={busy} onClick={() => act(confirm)}>
                {confirm === 'rotate' ? (p.token ? 'Make a new link' : 'Sign out everywhere') : `Remove ${p.display}`}
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
              {p.token ? <>…/?u=••••{p.token.slice(-4)}</> : owner ? 'The owner: signs in with his password' : 'Admin: signs in with a password, no link'}
            </code>
            {p.token && <Button size="sm" variant="secondary" onClick={async () => { if (!(await copy(link, p.display))) setShown({ link, why: 'copy' }) }}><Copy /> Copy link</Button>}
            {p.token && <Button size="sm" variant="ghost" onClick={() => setConfirm('rotate')}><KeyRound /> New link</Button>}
            {!p.token && managesSignIn(me, p) && <Button size="sm" variant="ghost" onClick={() => setConfirm('rotate')}><LogOut /> Sign out everywhere</Button>}
            {!owner && <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => setConfirm('remove')}><UserX /> Remove</Button>}
          </div>
        )}
      </div>
    </li>
  )
}

/** Where a person may take work, and how they sign in. Both are Ahmed's: the database refuses sessions. */
function Access({ p }: { p: Person }) {
  const qc = useQueryClient()
  const { data: projects = [] } = useProjects()
  const [off, setOff] = useState<string | null>(null) // asking first: taking them off a project where work waits on them
  const [pw, setPw] = useState<string | null>(null) // the new password while it's being typed
  const free = projects.filter((x) => !p.projects.includes(x.slug))
  const waiting = (slug: string) => [p.questions.filter((q) => q.project === slug).length, p.tasks.filter((t) => t.project === slug).length]
  const owner = p.name === 'ahmed'
  const me = useViewer(), local = useWho().data?.role === 'local'

  async function run(fn: string, args: object, ok: (r: any) => string) {
    try { const r = await rpc(fn, { name: p.name, ...args }); toast.success(ok(r)); await qc.invalidateQueries(); return true }
    catch (e: any) { toast.error(e.message); return false }
  }
  async function takeOff(slug: string) {
    const [nq, nt] = waiting(slug)
    if (off !== slug && nq + nt > 0) return setOff(slug)
    setOff(null)
    await run('user_project_remove', { project: slug }, (r) => `${p.display} is off ${slug}`
      + (r.questions + r.tasks > 0 ? `: ${plural(r.questions, 'question')} back to you, ${plural(r.tasks, 'task')} unassigned` : ''))
  }

  return (
    <div className="grid gap-2 border-t pt-3 text-sm">
      {!owner && <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-18 shrink-0 text-xs text-muted-foreground">Role</span>
        <span>{p.role === 'admin' ? 'Admin: the whole board, under their own name' : 'Member: what is handed to them'}</span>
        <Button size="xs" variant="ghost" onClick={() => run('user_set_role', { role: p.role === 'admin' ? 'member' : 'admin' },
          () => p.role === 'admin' ? `${p.display} is a member now` : `${p.display} is an admin now: they sign in with a password${p.has_password ? '' : ' (set one below)'}`)}>
          {p.role === 'admin' ? 'Make member' : 'Make admin'}
        </Button>
      </div>}
      {!owner && <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-18 shrink-0 text-xs text-muted-foreground">Projects</span>
        {p.projects.length === 0 && <span className="text-muted-foreground">None yet, so nothing can be handed to {p.display}.</span>}
        {p.projects.map((slug) => (
          <span key={slug} className="inline-flex h-6 items-center gap-1.5 rounded-md border bg-background pr-0.5 pl-2 text-xs">
            <ProjectDot slug={slug} />{slug}
            <button onClick={() => takeOff(slug)} aria-label={`Take ${p.display} off ${slug}`}
              className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-raised hover:text-foreground"><X className="size-3" /></button>
          </span>
        ))}
        {free.length > 0 && (
          <select value="" aria-label={`Put ${p.display} on a project`}
            onChange={(e) => { const slug = e.target.value; if (slug) run('user_project_add', { project: slug }, () => `${p.display} is on ${slug}`) }}
            className="h-6 rounded-md border border-dashed bg-transparent px-1.5 text-xs text-muted-foreground hover:border-input hover:text-foreground">
            <option value="">+ Project</option>
            {free.map((x) => <option key={x.slug} value={x.slug}>{x.name}</option>)}
          </select>
        )}
      </div>}
      {off && (() => {
        const [nq, nt] = waiting(off)
        return (
          <div role="group" aria-label={`Confirm taking ${p.display} off ${off}`} className="rounded-md bg-raised p-3"
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOff(null) } }}>
            <p className="text-pretty">
              Take {p.display} off {off}? {nq > 0 && <>{plural(nq, 'open question')} there come{nq === 1 && 's'} back to you. </>}
              {nt > 0 && <>{plural(nt, 'open task')} there become{nt === 1 && 's'} unassigned. </>}
            </p>
            <div className="mt-2.5 flex gap-2">
              <Button size="sm" onClick={() => takeOff(off)}>Take off {off}</Button>
              <Button size="sm" variant="ghost" autoFocus onClick={() => setOff(null)}>Cancel</Button>
            </div>
          </div>
        )
      })()}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-18 shrink-0 text-xs text-muted-foreground">Password</span>
        {pw === null ? <>
          <span className={cn(!p.has_password && (p.role === 'admin' ? 'text-destructive' : 'text-muted-foreground'))}>
            {p.has_password ? 'Set' : p.role === 'admin' ? 'None: they cannot sign in yet' : 'None, link only'}</span>
          {/* your own: the key icon at the top, which asks for the current one (on the PC's own dashboard there is none) */}
          {p.name === me && !local ? <span className="text-xs text-muted-foreground">yours: the key icon at the top</span>
            : managesSignIn(me, p) && <Button size="xs" variant="ghost" onClick={() => setPw('')}>{p.has_password ? 'Reset password' : 'Set password'}</Button>}
        </> : (
          // Shown as text, not dots: Ahmed types it to send it on. autoComplete off keeps it out of his own password manager.
          <form className="flex min-w-0 flex-1 items-center gap-1.5"
            onSubmit={async (e) => { e.preventDefault(); if (await run('user_password', { password: pw }, () => `Password set for ${p.display}. Send it to them privately.`)) setPw(null) }}>
            <Input autoFocus required minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="off" spellCheck={false}
              placeholder="8 characters or more" aria-label={`New password for ${p.display}`} className="h-7 min-w-0 flex-1 font-mono text-xs"
              onKeyDown={(e) => { if (e.key === 'Escape') setPw(null) }} />
            <Button size="sm" type="submit">Save</Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setPw(null)}>Cancel</Button>
          </form>
        )}
      </div>
    </div>
  )
}

/** Name and display name; then the link, ready to copy. Adding a name that exists keeps their link and updates the display name. */
function AddPerson({ open, onOpenChange, base, people }: { open: boolean; onOpenChange: (o: boolean) => void; base: string; people: Person[] }) {
  const qc = useQueryClient()
  const [display, setDisplay] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<'member' | 'admin'>('member')
  const [password, setPassword] = useState('')
  const [made, setMade] = useState<{ display: string; link: string | null } | null>(null)
  const auto = display.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9_-]/g, '') ?? ''
  const handle = name || auto
  const existing = people.find((p) => p.name === handle)

  function close(o: boolean) {
    onOpenChange(o)
    if (!o) { setDisplay(''); setName(''); setRole('member'); setPassword(''); setMade(null) }
  }
  async function add(e: React.FormEvent) {
    e.preventDefault()
    try {
      // an admin signs in by password only: set it with the account, or they could never sign in
      const token = await rpc<string | null>('user_add', { name: handle, display, role })
      if (role === 'admin') await rpc('user_password', { name: handle, password })
      setMade({ display: display.trim() || handle, link: token ? linkOf(base, token) : null })
      await qc.invalidateQueries()
    } catch (err: any) { toast.error(err.message) }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        {made && !made.link ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{made.display} is an admin</DialogTitle>
              <DialogDescription>They sign in at <span className="font-mono text-xs text-foreground">{base}/login</span> with
                the name <span className="font-mono text-xs text-foreground">{handle}</span> and the password you set. Send the password
                separately from the name. They can change it after signing in.</DialogDescription>
            </DialogHeader>
            <DialogFooter><Button variant="ghost" onClick={() => close(false)}>Done</Button></DialogFooter>
          </div>
        ) : made?.link ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{made.display}'s link</DialogTitle>
              <DialogDescription>Send it in a direct message, not a group chat: anyone with it can answer {made.display}'s questions. You can copy it again from Users any time.
                Next, put {made.display} on a project on their card: questions and tasks reach them only there.</DialogDescription>
            </DialogHeader>
            <LinkBox link={made.link} who={made.display} />
            <DialogFooter><Button variant="ghost" onClick={() => close(false)}>Done</Button></DialogFooter>
          </div>
        ) : (
          <form onSubmit={add} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Add a user</DialogTitle>
              <DialogDescription>A member answers the questions you hand them, through a private link or a password. An admin gets the whole board.</DialogDescription>
            </DialogHeader>
            <fieldset className="grid gap-1.5 text-sm">
              <legend className="mb-1.5 font-medium">Role</legend>
              <div className="flex gap-4">
                {(['member', 'admin'] as const).map((r) => (
                  <label key={r} className="flex items-center gap-2">
                    <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} className="accent-foreground" />
                    {r === 'member' ? 'Member: what you hand them' : 'Admin: the whole board'}
                  </label>
                ))}
              </div>
            </fieldset>
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
            {role === 'admin' && (
              // Shown as text, as on a card's Set password: Ahmed types it to send it on.
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Password</span>
                <Input required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" spellCheck={false}
                  placeholder="8 characters or more" className="font-mono" />
              </label>
            )}
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
