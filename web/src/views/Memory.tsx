import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { BookMarked, Plus, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { MEM_KINDS, rpc, useMemories, useMemStats, useProjects, type Memory as Mem } from '@/lib/api'
import { ago } from '@/lib/format'
import { go, type Route } from '@/lib/route'
import { cn } from '@/lib/utils'
import { ActorChip, ProjectChip, TaskId } from '@/components/Chips'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'

export const KIND: Record<Mem['kind'], { code: string; label: string; plural: string; hint: string }> = {
  rule: { code: 'R', label: 'Rule', plural: 'Rules', hint: 'How the team works, every time' },
  ruling: { code: 'RU', label: 'Ruling', plural: 'Rulings', hint: 'Your decision on a question that will come up again' },
  fact: { code: 'F', label: 'Fact', plural: 'Facts', hint: 'How a system is now. Goes stale after the review date' },
  gotcha: { code: 'G', label: 'Gotcha', plural: 'Gotchas', hint: 'A known trap. Goes stale after the review date' },
  runbook: { code: 'RB', label: 'Runbook', plural: 'Runbooks', hint: 'A procedure: sessions see the title and read it when needed' },
}
const FILTERS: { key: string; label: string; kinds: Mem['kind'][] }[] = [
  { key: '', label: 'All', kinds: [...MEM_KINDS] },
  { key: 'rules', label: 'Rules', kinds: ['rule', 'ruling'] },
  { key: 'facts', label: 'Facts', kinds: ['fact'] },
  { key: 'gotchas', label: 'Gotchas', kinds: ['gotcha'] },
  { key: 'runbooks', label: 'Runbooks', kinds: ['runbook'] },
]

async function act(fn: string, args: Record<string, unknown>, ok?: string) {
  try { const r = await rpc(fn, args); if (ok) toast(ok); return r ?? true }
  catch (e: any) { toast.error(e.message); return undefined }
}

/** Memory (9): what every session on every machine is told. Proposals wait for you; team notes go stale on their own. */
export function Memory({ route }: { route: Route }) {
  const [filter, setFilter] = useState('')
  const [showOld, setShowOld] = useState(false)
  const [adding, setAdding] = useState(false)
  const { data = [], isLoading } = useMemories(route.project, showOld)
  const kinds = FILTERS.find((f) => f.key === filter)!.kinds
  const shown = data.filter((m) => kinds.includes(m.kind))
  const waiting = shown.filter((m) => m.status === 'proposed')
  const stale = shown.filter((m) => m.status === 'active' && m.expired)
  const live = shown.filter((m) => m.status === 'active' && !m.expired)
  const old = shown.filter((m) => m.status === 'superseded' || m.status === 'retired')
  const showProject = !route.project

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.015em]">Memory</h1>
          <p className="mt-1 max-w-[72ch] text-sm text-muted-foreground text-pretty">
            What every session on every machine is told when it starts work{route.project ? ` in ${route.project}` : ''}. Rules and rulings carry your authority
            and need your click; facts and gotchas from sessions are a teammate's note and drop out after their review date.
          </p>
        </div>
        <Button className="ml-auto" onClick={() => setAdding(true)}><Plus /> New entry</Button>
      </header>
      <NewEntry key={route.project ?? ''} open={adding} onOpenChange={setAdding} project={route.project} />
      <Metric project={route.project} />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border bg-card p-0.5" role="group" aria-label="Filter by kind">
          {FILTERS.map((f) => (
            <button key={f.key} onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}
              className={cn('rounded px-2.5 py-1 text-sm transition-colors', filter === f.key ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
              {f.label}
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={showOld} onChange={(e) => setShowOld(e.target.checked)} className="size-3.5 accent-foreground" />
          Show retired and replaced
        </label>
      </div>

      {isLoading ? <p className="text-sm text-muted-foreground">Loading memory…</p>
        : data.length === 0 ? (
          <div className="rounded-lg border border-dashed px-6 py-10 text-center">
            <BookMarked className="mx-auto mb-3 size-5 text-muted-foreground" />
            <p className="font-medium">Nothing remembered yet.</p>
            <p className="mx-auto mt-1 max-w-[62ch] text-sm text-muted-foreground text-pretty">
              Add a rule with <strong className="font-medium text-foreground">New entry</strong>, or turn an answered question into a ruling with
              {' '}<strong className="font-medium text-foreground">Make it a rule</strong> on Today. Sessions add facts and gotchas
              with <code className="font-mono text-xs">cb mem add</code>.
            </p>
          </div>
        ) : (
          <div className="grid gap-8">
            {waiting.length > 0 && (
              <Section label="Waiting for you" note="Sessions don't see these until you confirm." items={waiting}
                row={(m) => <Row key={m.id} m={m} showProject={showProject} mode="proposed" />} lit />
            )}
            {stale.length > 0 && (
              <Section label="Stale, review" note="Past their review date: out of what sessions are told until renewed." items={stale}
                row={(m) => <Row key={m.id} m={m} showProject={showProject} mode="stale" />} />
            )}
            <Section label="Live" note={live.length ? undefined : 'Nothing live here yet.'} items={live}
              row={(m) => <Row key={m.id} m={m} showProject={showProject} mode="live" />} />
            {showOld && old.length > 0 && (
              <Section label="Retired and replaced" items={old} row={(m) => <Row key={m.id} m={m} showProject={showProject} mode="old" />} />
            )}
          </div>
        )}
    </div>
  )
}

/** How we'd know it works (#553), last 7 days: repeat questions you closed with a rule, corrections sessions noted,
 *  and how much of what sessions are told as fact has gone stale (target under 15%). */
function Metric({ project }: { project?: string }) {
  const { data: m } = useMemStats(project)
  if (!m) return null
  const over = (m.stale_pct ?? 0) >= 15
  return (
    <p className="mb-6 flex flex-wrap gap-x-5 gap-y-1 rounded-lg border bg-card px-4 py-2.5 text-sm text-muted-foreground" aria-label="Last 7 days">
      <span className="font-medium text-foreground">Last 7 days</span>
      <span><span className="callsign text-foreground">{m.already_ruled}</span> answered "Already ruled"</span>
      <span title="cb log notes saying correction, stale or was wrong"><span className="callsign text-foreground">{m.corrections}</span> corrections noted</span>
      <span>
        <span className={cn('callsign', over ? 'text-st-blocked' : 'text-foreground')}>{m.stale_pct ?? 0}%</span> of {m.live_facts} live facts past review
        <span className="text-xs"> (target under 15%)</span>
      </span>
    </p>
  )
}

function Section({ label, note, items, row, lit }: { label: string; note?: string; items: Mem[]; row: (m: Mem) => React.ReactNode; lit?: boolean }) {
  return (
    <section aria-label={label}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 px-1">
        <h2 className={cn('callsign text-[15px]', lit && 'text-lamp')}>{label} <span className="font-normal text-muted-foreground tabular-nums">{items.length}</span></h2>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
      {items.length > 0 && <ul className="overflow-hidden rounded-lg border bg-card">{items.map(row)}</ul>}
    </section>
  )
}

type Mode = 'proposed' | 'stale' | 'live' | 'old'

function Row({ m, showProject, mode }: { m: Mem; showProject: boolean; mode: Mode }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const done = async (r: unknown) => { if (r !== undefined) await qc.invalidateQueries() }
  const old = mode === 'old'
  return (
    <li className="border-b last:border-b-0">
      <div className="grid gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="min-w-0">
          <button onClick={() => setOpen(!open)} aria-expanded={open} disabled={!m.body}
            className="flex w-full min-w-0 items-baseline gap-2.5 text-left disabled:cursor-default">
            <span className="callsign w-6 shrink-0 text-[13px] text-muted-foreground" title={KIND[m.kind].label}>{KIND[m.kind].code}</span>
            <span className="callsign w-9 shrink-0 text-[13px] text-muted-foreground">M{m.id}</span>
            <span className={cn('min-w-0 font-medium text-pretty', old && 'text-muted-foreground line-through decoration-muted-foreground/40')}>{m.title}</span>
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[4.375rem] text-xs text-muted-foreground">
            {m.authority === 'ahmed' ? <span className="font-medium text-foreground">Yours</span>
              : <span className="inline-flex items-center gap-1.5">team, not you: <ActorChip actor={m.created_by} /></span>}
            {showProject && (m.project ? <ProjectChip slug={m.project} /> : <span>global</span>)}
            {m.machine && <span>{m.machine} only</span>}
            {m.review_after && mode !== 'old' && <span className={cn(m.expired && 'text-st-blocked')}>review {m.review_after.slice(0, 10)}</span>}
            {m.source.question_id && <span>from Q{m.source.question_id}</span>}
            {m.source.task_id && <TaskId id={m.source.task_id} />}
            {m.source.supersedes && <span>replaces M{m.source.supersedes}</span>}
            {m.superseded_by && <span>replaced by M{m.superseded_by}</span>}
            {old && <span className="capitalize">{m.status}</span>}
            <span className="tabular-nums">{ago(m.created_at)}</span>
          </div>
          {m.source.flagged && mode === 'proposed' && (
            <p className="mt-1.5 flex items-center gap-1.5 pl-[4.375rem] text-xs text-st-blocked">
              <TriangleAlert className="size-3.5" /> Reads like an instruction to the agent or carries a URL. Check it before confirming.
            </p>
          )}
          {open && m.body && <p className="mt-2 pl-[4.375rem] text-sm whitespace-pre-wrap text-pretty text-foreground/90">{m.body}</p>}
        </div>
        {!old && (
          <div className="flex flex-wrap items-center gap-1.5 pl-[4.375rem] sm:justify-end sm:pl-0">
            {mode === 'proposed' && <>
              <Button size="sm" onClick={async () => done(await act('mem_confirm', { id: m.id }, `M${m.id} confirmed: sessions see it now`))}>Confirm</Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit</Button>
              <Button size="sm" variant="ghost" onClick={async () => done(await act('mem_retire', { id: m.id }, `M${m.id} rejected`))}>Reject</Button>
            </>}
            {mode === 'stale' && <>
              <Button size="sm" onClick={async () => done(await act('mem_confirm', { id: m.id }, `M${m.id} renewed for 14 days`))}>Still true</Button>
              <Button size="sm" variant="ghost" onClick={async () => done(await act('mem_retire', { id: m.id }, `M${m.id} retired`))}>Retire</Button>
            </>}
            {mode === 'live' && <>
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Change</Button>
              <Button size="sm" variant="ghost" onClick={async () => done(await act('mem_retire', { id: m.id }, `M${m.id} retired`))}>Retire</Button>
            </>}
          </div>
        )}
      </div>
      {editing && <EditEntry m={m} confirm={mode === 'proposed'} onClose={() => setEditing(false)} />}
    </li>
  )
}

/** A proposal: edit, then confirm. A live entry: the change becomes a new entry that replaces it (the old one stays readable). */
function EditEntry({ m, confirm, onClose }: { m: Mem; confirm: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [title, setTitle] = useState(m.title)
  const [body, setBody] = useState(m.body)
  async function save(e: React.FormEvent) {
    e.preventDefault()
    const r = confirm
      ? await act('mem_confirm', { id: m.id, title, body }, `M${m.id} confirmed: sessions see it now`)
      : await act('mem_supersede', { id: m.id, title, body }, `M${m.id} replaced`)
    if (r === undefined) return
    onClose()
    await qc.invalidateQueries()
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={save} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{confirm ? `Edit and confirm M${m.id}` : `Change M${m.id}`}</DialogTitle>
            <DialogDescription>
              {confirm ? 'Your wording goes live as yours.' : 'Saved as a new entry that replaces this one; the old one stays readable as replaced.'}
            </DialogDescription>
          </DialogHeader>
          <Input autoFocus required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title (one line)" />
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={m.kind === 'runbook' ? undefined : 500}
            placeholder="Details (optional)…" aria-label="Details" />
          <DialogFooter><Button type="submit">{confirm ? 'Confirm' : 'Save change'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function NewEntry({ open, onOpenChange, project }: { open: boolean; onOpenChange: (o: boolean) => void; project?: string }) {
  const qc = useQueryClient()
  const { data: projects = [] } = useProjects()
  const [proj, setProj] = useState(project ?? '')
  const [kind, setKind] = useState<Mem['kind']>('rule')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  async function create(e: React.FormEvent) {
    e.preventDefault()
    const m: any = await act('mem_add', { project: proj, title, kind, body })
    if (m === undefined) return
    toast(`M${m.id} saved: ${m.project ? `${m.project} sessions` : 'every session'} see it from now on`)
    setTitle(''); setBody('')
    onOpenChange(false)
    await qc.invalidateQueries()
    go({ view: 'memory' })
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={create} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New entry</DialogTitle>
            <DialogDescription>{KIND[kind].hint}.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap rounded-md border bg-card p-0.5" role="radiogroup" aria-label="Kind">
            {MEM_KINDS.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
                className={cn('flex-1 rounded px-2.5 py-1 text-sm transition-colors', kind === k ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
                {KIND[k].label}
              </button>
            ))}
          </div>
          <Input autoFocus required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="One line a session acts on, e.g. Every merge needs a GO from another session…" aria-label="Title (one line)" />
          <Input required list="cb-projects-mem" value={proj} onChange={(e) => setProj(e.target.value)} spellCheck={false}
            placeholder="project, or global for how every session works…" aria-label="Project, or global" />
          <datalist id="cb-projects-mem"><option value="global" />{projects.map((p) => <option key={p.slug} value={p.slug} />)}</datalist>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={kind === 'runbook' ? 8 : 3} maxLength={kind === 'runbook' ? undefined : 500}
            placeholder={kind === 'runbook' ? 'The steps…' : 'Why, or where it is written down (optional)…'} aria-label="Details" />
          <DialogFooter><Button type="submit">Save {KIND[kind].label.toLowerCase()}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
