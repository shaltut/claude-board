import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowLeft, GripVertical, Plus, Sparkles, Target } from 'lucide-react'
import { toast } from 'sonner'
import { rpc, useGoal, useGoals, useProjects, type Goal, type GoalCard, type GoalRules, type Task } from '@/lib/api'
import { ago, STATUS } from '@/lib/format'
import { dropIndex, rankAt } from '@/lib/rank'
import { go, type Route } from '@/lib/route'
import { cn } from '@/lib/utils'
import { ActorChip, ProjectChip, StatusDot, TaskId } from '@/components/Chips'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'

/** Goals (0): what matters now. A goal's cards are handed out right after P0, in this order. ?goal=<id> opens one. */
export function Goals({ route }: { route: Route }) {
  return route.goal ? <GoalPage key={route.goal} id={route.goal} /> : <GoalList route={route} />
}

async function act(fn: string, args: Record<string, unknown>, ok?: string) {
  try { const r = await rpc(fn, args); if (ok) toast(ok); return r }
  catch (e: any) { toast.error(e.message); return undefined }
}

const EMPTY: GoalRules = { labels: [], words: [], epics: [] }
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

/** "3 of 8 closed": a hairline bar in the done green. */
export function GoalProgress({ g, className }: { g: Goal; className?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <div className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-raised sm:w-36" aria-hidden>
        <div className="h-full bg-st-done" style={{ width: `${g.total ? (g.closed / g.total) * 100 : 0}%` }} />
      </div>
      <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
        <span className="font-medium text-foreground">{g.closed} of {g.total}</span> closed
      </span>
    </div>
  )
}

function Scope({ project }: { project: string | null }) {
  return project ? <ProjectChip slug={project} /> : <span className="text-xs text-muted-foreground">Every project</span>
}

function GoalList({ route }: { route: Route }) {
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const { data = [], isLoading } = useGoals(route.project)
  const active = data.filter((g) => g.status === 'active')
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  async function onEnd(ev: DragEndEvent) {
    if (!ev.over) return
    const index = dropIndex(active, Number(ev.active.id), ev.over.id, true)
    if (index === null) return
    const rest = active.filter((g) => g.id !== ev.active.id)
    await act('goal_update', { id: `G${ev.active.id}`, rank: rankAt(rest, index) })
    await qc.invalidateQueries()
  }

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.015em]">Goals</h1>
          <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground text-pretty">
            What matters now. Every card that fits an active goal, filed before or after you set it, is handed out right after P0,
            in the order below. Drag to reorder.
          </p>
        </div>
        <Button className="ml-auto" onClick={() => setCreating(true)}><Plus /> New goal</Button>
      </header>
      <NewGoal key={route.project ?? ''} open={creating} onOpenChange={setCreating} project={route.project} />

      {isLoading ? <p className="text-sm text-muted-foreground">Loading goals…</p>
        : data.length === 0 ? (
          <div className="rounded-lg border border-dashed px-6 py-10 text-center">
            <p className="font-medium">No goals yet.</p>
            <p className="mx-auto mt-1 max-w-[60ch] text-sm text-muted-foreground text-pretty">
              Say what matters, e.g. <em>"we need to improve our OCR/vision"</em>. The board proposes labels and words from it,
              you check the cards they catch, and those cards go first from then on.
            </p>
          </div>
        ) : (
          <div className="grid gap-8">
            {active.length > 0 && (
              <section aria-label="Active goals">
                <h2 className="callsign mb-2 px-1 text-[15px]">Active <span className="font-normal text-muted-foreground tabular-nums">{active.length}</span></h2>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onEnd}>
                  <ol className="overflow-hidden rounded-lg border bg-card">
                    <SortableContext items={active.map((g) => g.id)} strategy={verticalListSortingStrategy}>
                      {active.map((g, i) => <GoalRow key={g.id} g={g} place={i + 1} />)}
                    </SortableContext>
                  </ol>
                </DndContext>
              </section>
            )}
            {(['paused', 'done'] as const).map((s) => {
              const rows = data.filter((g) => g.status === s)
              return rows.length > 0 && (
                <section key={s} aria-label={`${s} goals`}>
                  <h2 className="callsign mb-2 px-1 text-[15px]">{s === 'paused' ? 'Paused' : 'Done'} <span className="font-normal text-muted-foreground tabular-nums">{rows.length}</span></h2>
                  <ul className="overflow-hidden rounded-lg border bg-card">{rows.map((g) => <GoalRow key={g.id} g={g} />)}</ul>
                </section>
              )
            })}
          </div>
        )}
    </div>
  )
}

function GoalRow({ g, place }: { g: Goal; place?: number }) {
  const sortable = useSortable({ id: g.id, disabled: !place })
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('flex items-center gap-2 border-b bg-card pl-2 last:border-b-0', isDragging && 'relative z-10 rounded-md border opacity-90 shadow-lg')}>
      {place ? (
        <button {...attributes} {...listeners} className="grid h-7 w-5 shrink-0 cursor-grab touch-none place-items-center rounded text-muted-foreground/45 hover:bg-raised hover:text-foreground active:cursor-grabbing" aria-label={`Reorder G${g.id}`}>
          <GripVertical className="size-4" />
        </button>
      ) : <span className="w-5 shrink-0" />}
      <a href={`#/goals?goal=${g.id}`} onClick={(ev) => { if (ev.metaKey || ev.ctrlKey) return; ev.preventDefault(); go({ goal: g.id }) }}
        className="grid min-w-0 flex-1 gap-x-4 gap-y-1.5 py-3 pr-4 outline-none transition-colors hover:bg-raised/50 focus-visible:bg-raised/60 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
          <div className="flex min-w-0 items-baseline gap-2.5">
            <span className="callsign w-8 shrink-0 text-[14px] text-muted-foreground">{place ? `${place}.` : ''} G{g.id}</span>
            <span className={cn('truncate font-medium', g.status !== 'active' && 'text-muted-foreground')}>{g.title}</span>
            {g.new > 0 && <span className="shrink-0 rounded bg-lamp/15 px-1.5 text-[11px] font-semibold text-lamp">{g.new} new</span>}
          </div>
          {g.description && <p className="mt-0.5 truncate pl-[2.625rem] text-[13px] text-muted-foreground">{g.description}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:justify-end">
          <Scope project={g.project} />
          <GoalProgress g={g} />
        </div>
      </a>
    </li>
  )
}

/** The three rule lists as comma-separated fields. */
function RulesFields({ rules, onChange }: { rules: GoalRules; onChange: (r: GoalRules) => void }) {
  const [text, setText] = useState({ labels: rules.labels.join(', '), words: rules.words.join(', '), epics: rules.epics.map((e) => `E${e}`).join(', ') })
  useEffect(() => setText({ labels: rules.labels.join(', '), words: rules.words.join(', '), epics: rules.epics.map((e) => `E${e}`).join(', ') }),
    [rules.labels.join(), rules.words.join(), rules.epics.join()]) // eslint-disable-line react-hooks/exhaustive-deps
  const field = (k: keyof GoalRules, label: string, hint: string) => (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label} <span className="font-normal text-muted-foreground">{hint}</span></span>
      <Input value={text[k]} spellCheck={false} onChange={(e) => setText({ ...text, [k]: e.target.value })}
        onBlur={() => onChange({ ...rules, [k]: k === 'epics' ? list(text.epics).map((x) => Number(x.replace(/^[#e]+/i, ''))).filter((n) => n > 0) : list(text[k]) })} />
    </label>
  )
  return (
    <div className="grid gap-3">
      {field('labels', 'Labels', 'a card with any of these tags')}
      {field('words', 'Words', 'or any of these in its title or body')}
      {field('epics', 'Epics', 'or a step of one of these, e.g. E3')}
    </div>
  )
}

/** What the rules match right now, debounced. */
function usePreview(rules: GoalRules, project: string | null) {
  const key = JSON.stringify([rules, project])
  const [k, setK] = useState(key)
  useEffect(() => { const t = setTimeout(() => setK(key), 300); return () => clearTimeout(t) }, [key])
  const [r, p] = JSON.parse(k) as [GoalRules, string | null]
  return useQuery({ queryKey: ['goal-preview', k], queryFn: () => rpc<Task[]>('goal_preview', { rules: r, project: p }) })
}

/** Cards the rules catch, each with a tick; an unticked one stays out of the goal for good (unless ticked back). */
function PreviewList({ cards, skip, onToggle, loading }: { cards: Task[]; skip?: Set<number>; onToggle?: (id: number) => void; loading?: boolean }) {
  if (loading) return <p className="text-sm text-muted-foreground">Matching…</p>
  if (!cards.length) return <p className="text-sm text-muted-foreground">No open card matches these rules yet. New cards that do will join.</p>
  return (
    <ul className="max-h-72 overflow-y-auto rounded-md border">
      {cards.map((t) => (
        <li key={t.id} className="flex items-center gap-2.5 border-b px-3 py-1.5 text-sm last:border-b-0">
          {onToggle && <Checkbox checked={!skip?.has(t.id)} onCheckedChange={() => onToggle(t.id)} aria-label={`Include #${t.id}`} />}
          <TaskId id={t.id} className="w-10 shrink-0" />
          <span className="text-xs text-muted-foreground">{t.priority}</span>
          <span className={cn('min-w-0 flex-1 truncate', skip?.has(t.id) && 'text-muted-foreground line-through')}>{t.title}</span>
          <ProjectChip slug={t.project} />
        </li>
      ))}
    </ul>
  )
}

/** Ahmed sets a goal: say it, take or edit the proposed rules, check the cards they catch, save. */
function NewGoal({ open, onOpenChange, project }: { open: boolean; onOpenChange: (o: boolean) => void; project?: string }) {
  const qc = useQueryClient()
  const { data: projects = [] } = useProjects()
  const [proj, setProj] = useState(project ?? '')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [rules, setRules] = useState<GoalRules>(EMPTY)
  const [skip, setSkip] = useState<Set<number>>(new Set())
  const preview = usePreview(rules, proj || null)
  const hasRules = rules.labels.length + rules.words.length + rules.epics.length > 0

  async function propose() {
    const r = await act('goal_propose', { description: `${title} ${description}`, project: proj || null }) as GoalRules | undefined
    if (r) setRules(r)
  }
  async function create(e: React.FormEvent) {
    e.preventDefault()
    const id = await act('goal_create', { title, description, project: proj || null, rules, skip: [...skip] })
    if (id == null) return
    setTitle(''); setDescription(''); setRules(EMPTY); setSkip(new Set())
    onOpenChange(false)
    await qc.invalidateQueries()
    go({ goal: Number(id) })
  }
  const toggle = (id: number) => setSkip((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n })
  const caught = (preview.data ?? []).filter((t) => !skip.has(t.id)).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={create} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New goal</DialogTitle>
            <DialogDescription>Its cards go right after P0, before ordinary work. Sessions are told; new cards that fit join by themselves.</DialogDescription>
          </DialogHeader>
          <Input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title, e.g. Improve OCR and vision…" aria-label="Title" />
          <Input list="cb-projects-goal" value={proj} onChange={(e) => setProj(e.target.value)} placeholder="project, or blank for every project…" spellCheck={false} aria-label="Project" />
          <datalist id="cb-projects-goal">{projects.map((p) => <option key={p.slug} value={p.slug} />)}</datalist>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="What matters, in a sentence: we need to improve our OCR/vision…" aria-label="Description" />
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">Which cards</span>
            <Button type="button" variant="outline" size="sm" onClick={propose} disabled={!title.trim() && !description.trim()}><Sparkles /> Propose from the description</Button>
          </div>
          <RulesFields rules={rules} onChange={setRules} />
          {hasRules && <PreviewList cards={preview.data ?? []} skip={skip} onToggle={toggle} loading={preview.isLoading} />}
          <DialogFooter><Button type="submit">Set goal{hasRules ? ` (${caught} cards)` : ''}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function GoalPage({ id }: { id: number }) {
  const qc = useQueryClient()
  const { data, isLoading } = useGoal(id)
  // new is cleared once Ahmed opens the goal; keep marking what was new on arrival while he is here
  const fresh = useRef<Set<number> | null>(null)
  useEffect(() => {
    if (!data || fresh.current) return
    fresh.current = new Set(data.cards.filter((c) => c.new).map((c) => c.id))
    if (fresh.current.size) rpc('goal_opened', { id: `G${id}` }).catch(() => {})
  }, [data, id])
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading G{id}…</p>
  if (!data) return (
    <div className="mx-auto max-w-5xl"><Back /><p className="text-sm text-muted-foreground">There is no goal G{id}.</p></div>
  )
  const { goal: g, cards } = data
  const refresh = () => qc.invalidateQueries()
  const inCards = cards.filter((c) => c.state === 'in'), outCards = cards.filter((c) => c.state === 'out')
  async function tick(c: GoalCard, state: 'in' | 'out') {
    if (await act('goal_tick', { goal: `G${g.id}`, task: String(c.id), state }, state === 'out' ? `#${c.id} dropped from G${g.id}` : `#${c.id} back in G${g.id}`) !== undefined) refresh()
  }

  return (
    <div className="mx-auto max-w-5xl">
      <Back />
      <GoalHeader g={g} />
      <RulesEditor g={g} />
      <section aria-labelledby="cards" className="mt-8">
        <h2 id="cards" className="text-xl leading-tight font-semibold tracking-[-0.01em]">Cards <span className="text-base font-normal text-muted-foreground tabular-nums">{inCards.length}</span></h2>
        <p className="mb-3 text-sm text-muted-foreground">Untick a card to drop it: matching never brings it back. <span className="text-lamp">New</span> = joined since you last looked.</p>
        <ul className="overflow-hidden rounded-lg border bg-card">
          {inCards.map((c) => <CardRow key={c.id} c={c} fresh={!!fresh.current?.has(c.id) || c.new} onTick={tick} />)}
          {inCards.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted-foreground">No cards yet. Cards that match the rules join as they are filed.</li>}
        </ul>
        <AddCard g={g} onAdded={refresh} />
        {outCards.length > 0 && (
          <details className="mt-6">
            <summary className="cursor-pointer text-sm text-muted-foreground">Dropped ({outCards.length})</summary>
            <ul className="mt-2 overflow-hidden rounded-lg border bg-card">{outCards.map((c) => <CardRow key={c.id} c={c} onTick={tick} />)}</ul>
          </details>
        )}
      </section>
    </div>
  )
}

function Back() {
  return (
    <a href="#/goals" onClick={(ev) => { ev.preventDefault(); go({ goal: undefined }) }}
      className="mb-4 inline-flex items-center gap-1.5 rounded px-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-3.5" /> All goals
    </a>
  )
}

function GoalHeader({ g }: { g: Goal }) {
  const qc = useQueryClient()
  const [title, setTitle] = useState(g.title)
  const [description, setDescription] = useState(g.description)
  useEffect(() => setTitle(g.title), [g.title])
  useEffect(() => setDescription(g.description), [g.description])
  const save = async (args: Record<string, unknown>, ok: string) => { await act('goal_update', { id: `G${g.id}`, ...args }, ok); await qc.invalidateQueries() }
  const status = async (s: Goal['status'], ok: string) => { await act('goal_status', { id: `G${g.id}`, status: s }, ok); await qc.invalidateQueries() }
  return (
    <header className="rounded-[10px] border bg-card p-5 shadow-[inset_3px_0_0_var(--foreground)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><Target className="size-3.5" /><span className="callsign text-[14px] text-foreground">G{g.id}</span></span>
        <Scope project={g.project} />
        <span className={cn(g.status === 'active' ? 'text-st-progress' : g.status === 'done' ? 'text-st-done' : '')}>
          {g.status === 'active' ? 'Active: its cards go right after P0' : g.status === 'paused' ? 'Paused: no effect on order, takes no new cards' : `Done ${g.closed_at ? ago(g.closed_at) : ''}`}
        </span>
        <span>set by <ActorChip actor={g.created_by} /> {ago(g.created_at)}</span>
      </div>
      <Input value={title} onChange={(ev) => setTitle(ev.target.value)} aria-label="Goal title"
        onBlur={() => title.trim() && title.trim() !== g.title && save({ title: title.trim() }, `G${g.id} renamed`)}
        onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur() }}
        className="-mx-2 mt-2 h-auto border-transparent bg-transparent px-2 py-1 text-[24px] leading-tight font-semibold tracking-[-0.015em] shadow-none hover:border-input focus-visible:border-input md:text-[24px] dark:bg-transparent" />
      <Textarea value={description} onChange={(ev) => setDescription(ev.target.value)} rows={2} aria-label="Description"
        placeholder="What matters, in a sentence…"
        onBlur={() => description !== g.description && save({ description }, 'Description saved')}
        className="-mx-2 mt-1 min-h-0 border-transparent bg-transparent px-2 text-sm text-muted-foreground shadow-none hover:border-input focus-visible:border-input dark:bg-transparent" />
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3">
        <GoalProgress g={g} />
        <div className="ml-auto flex gap-2">
          {g.status === 'active' && <Button size="sm" variant="outline" onClick={() => status('paused', `G${g.id} paused`)}>Pause</Button>}
          {g.status !== 'active' && <Button size="sm" variant="outline" onClick={() => status('active', `G${g.id} active; sessions are told`)}>{g.status === 'paused' ? 'Resume' : 'Reopen'}</Button>}
          {g.status !== 'done' && <Button size="sm" variant="outline" onClick={() => status('done', `G${g.id} closed`)}>Close goal</Button>}
        </div>
      </div>
    </header>
  )
}

/** The saved rules; edit them and see what they would catch before saving. Saving adds the new matches. */
function RulesEditor({ g }: { g: Goal }) {
  const qc = useQueryClient()
  const [rules, setRules] = useState<GoalRules>(g.rules)
  const saved = JSON.stringify(g.rules)
  useEffect(() => setRules(JSON.parse(saved)), [saved])
  const dirty = JSON.stringify(rules) !== saved
  const preview = usePreview(rules, g.project)
  async function save() {
    if (await act('goal_update', { id: `G${g.id}`, rules }, 'Rules saved; matching cards joined') !== undefined) await qc.invalidateQueries()
  }
  return (
    <section aria-labelledby="rules" className="mt-8 rounded-lg border p-4">
      <h2 id="rules" className="mb-3 text-base font-semibold">Rules</h2>
      <RulesFields rules={rules} onChange={setRules} />
      {dirty && (
        <div className="mt-4 grid gap-2">
          <p className="text-sm text-muted-foreground">These rules catch {preview.data?.length ?? '…'} open cards now. Saving adds the ones not in yet; cards that stop matching stay until you untick them.</p>
          <PreviewList cards={preview.data ?? []} loading={preview.isLoading} />
          <div className="flex gap-2">
            <Button size="sm" onClick={save}>Save rules</Button>
            <Button size="sm" variant="ghost" onClick={() => setRules(JSON.parse(saved))}>Cancel</Button>
          </div>
        </div>
      )}
    </section>
  )
}

function CardRow({ c, fresh, onTick }: { c: GoalCard; fresh?: boolean; onTick: (c: GoalCard, s: 'in' | 'out') => void }) {
  const closed = c.status === 'done' || c.status === 'cancelled'
  return (
    <li className="flex min-h-11 items-center gap-2.5 border-b px-3 py-1.5 text-sm last:border-b-0">
      <Checkbox checked={c.state === 'in'} onCheckedChange={(v) => onTick(c, v ? 'in' : 'out')} aria-label={c.state === 'in' ? `Drop #${c.id}` : `Tick #${c.id} back in`} />
      <span className={cn('inline-flex w-[6.5rem] shrink-0 items-center gap-1.5 text-xs', c.status === 'done' ? 'text-st-done' : 'text-muted-foreground')}>
        <StatusDot status={c.status} />{STATUS[c.status].label}
      </span>
      <TaskId id={c.id} className="w-10 shrink-0" />
      <span className="w-6 shrink-0 text-xs text-muted-foreground">{c.priority}</span>
      <a href={`#/goals?t=${c.id}`} onClick={(ev) => { ev.preventDefault(); go({ task: c.id }) }}
        className={cn('min-w-0 flex-1 truncate font-medium hover:underline hover:underline-offset-4', (closed || c.state === 'out') && 'text-muted-foreground', c.status === 'cancelled' && 'line-through')}>
        {c.title}
      </a>
      {fresh && <span className="shrink-0 rounded bg-lamp/15 px-1.5 text-[11px] font-semibold text-lamp">new</span>}
      {c.via === 'ahmed' && <span className="shrink-0 text-[11px] text-muted-foreground" title="You added it by hand">by you</span>}
      <ProjectChip slug={c.project} />
      {c.assignee && <ActorChip actor={c.assignee} />}
    </li>
  )
}

/** Tick any card in by number (it joins via ahmed). */
function AddCard({ g, onAdded }: { g: Goal; onAdded: () => void }) {
  const [pick, setPick] = useState('')
  async function add(ev: React.FormEvent) {
    ev.preventDefault()
    const id = Number(/#?(\d+)/.exec(pick)?.[1])
    if (!id) return
    if (await act('goal_tick', { goal: `G${g.id}`, task: String(id), state: 'in' }, `#${id} added to G${g.id}`) === undefined) return
    setPick('')
    onAdded()
  }
  return (
    <form onSubmit={add} className="mt-3 flex gap-2">
      <Input value={pick} onChange={(ev) => setPick(ev.target.value)} spellCheck={false} className="max-w-xs"
        placeholder="Add a card the rules miss: #id…" aria-label="Add a card by number" />
      <Button type="submit" variant="outline" disabled={!/\d/.test(pick)}>Add card</Button>
    </form>
  )
}
