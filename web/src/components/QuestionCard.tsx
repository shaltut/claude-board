import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, CornerDownLeft, CornerDownRight, Loader2, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { BACK_REASONS, onProject, rpc, useUsers, type BackReason, type Question } from '@/lib/api'
import { ago } from '@/lib/format'
import { go } from '@/lib/route'
import { Textarea } from '@/components/ui/textarea'
import { VoiceTextarea } from './VoiceTextarea'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { ActorChip, ProjectChip, TaskId } from './Chips'
import { Md } from './Md'
import { AlreadyRuled, MakeRule } from './MakeRule'

const RECOMMENDED = /\s*\(recommended\)\s*$/i

/** An open question from Claude, answerable in place: one click on an option sends it.
 *  Draft text lives here, keyed by question id, so live refetches never wipe what Ahmed is typing.
 *  On success the lamp turns green and the strip leaves; onCleared fires once it has gone. */
export function QuestionCard({ q, onAnswered, onClearing, onCleared, guest }: {
  q: Question; onAnswered?: (id: number) => void; onClearing?: (q: Question) => void; onCleared?: (id: number) => void; guest?: boolean
}) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [showContext, setShowContext] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [cleared, setCleared] = useState(false)
  const [showPrev, setShowPrev] = useState(false)
  const [armed, setArmed] = useState<BackReason | null>(null) // a send-back that would take typed text as its note asks twice
  const prev = q.versions?.at(-1)
  const rewrote = prev && BACK_REASONS.find((r) => r.key === prev.reason)?.past

  /** ruled: answer "Already ruled" with that memory entry; the server writes the text, so the session gets the rule. */
  async function send(answer: string, via = '__text', ruled?: number) {
    if (!answer.trim() || busy) return
    setBusy(via)
    try {
      await rpc('answer', ruled ? { id: q.id, ruled_by: `M${ruled}` } : { id: q.id, answer })
      onClearing?.(q)
      setCleared(true)
      toast.success(`Answered Q${q.id}`, {
        description: answer.length > 80 ? answer.slice(0, 80) + '…' : answer,
        action: onAnswered ? { label: 'Change', onClick: () => onAnswered(q.id) } : undefined,
      })
      await qc.invalidateQueries()
    } catch (e: any) {
      toast.error(`Could not answer Q${q.id}`, { description: e.message })
    } finally {
      setBusy(null)
    }
  }

  /** Back to the asking session for a rewrite, one tap per reason like Telegram (#1206): it leaves the list like an
   *  answer does. Whatever is typed in the box rides along as the note; clarify needs it (it is his question). */
  async function sendBack(reason: BackReason) {
    if (busy) return
    const note = text.trim()
    if (reason === 'clarify' && !note) return toast.error('Type your question for the session in the box first, then tap Ask a question.')
    // review: a mis-tap aimed at Send would turn a typed answer into a send-back note; the first tap only arms it
    if (note && reason !== 'clarify' && armed !== reason) { setArmed(reason); setTimeout(() => setArmed((r) => (r === reason ? null : r)), 4000); return }
    setArmed(null)
    setBusy(`__back:${reason}`)
    try {
      await rpc('send_back', { id: String(q.id), reason, note: note || null })
      onClearing?.(q)
      setCleared(true)
      toast.success(`Sent Q${q.id} back`, { description: 'It comes back here once the session rewrites it.' })
      await qc.invalidateQueries()
    } catch (e: any) {
      toast.error(`Could not send Q${q.id} back`, { description: e.message })
    } finally {
      setBusy(null)
    }
  }

  const withNote = (base: string) => (text.trim() ? `${base} — ${text.trim()}` : base)
  const sendTyped = () => send(q.multi && picked.length ? withNote(picked.join('; ')) : text)
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendTyped() }
  }
  const holding = q.blocking && !cleared
  // The amber lamp means "waiting on whoever is looking": Ahmed for his own, the guest on their page.
  // A question handed to someone else shows on Ahmed's Today as a dark lamp.
  const lit = guest || !q.assigned_to

  return (
    <article data-cleared={cleared || undefined}
      onAnimationEnd={(e) => { if (cleared && e.target === e.currentTarget) onCleared?.(q.id) }}
      className={cn('relative grid grid-cols-[1.75rem_minmax(0,1fr)] rounded-lg border bg-card py-4 pr-4 transition-[border-color,box-shadow] duration-300 sm:grid-cols-[2.5rem_minmax(0,1fr)] sm:py-5 sm:pr-5',
        holding && lit && 'shadow-[inset_3px_0_0_var(--lamp)]',
        cleared && 'clearing shadow-[inset_3px_0_0_var(--clear)]')}
      aria-labelledby={`q${q.id}-body`}>
      <div className="flex justify-center pt-[7px]">
        {cleared
          ? <span className="size-2.5 rounded-full bg-clear shadow-[0_0_0_3px_color-mix(in_oklab,var(--clear)_22%,transparent),0_0_12px_var(--clear)]" title="Answered" />
          : lit
            ? <span className={cn('lamp size-2.5', holding && 'lamp-breathe')} title={q.blocking ? 'Holding work until you answer' : 'Waiting on you'} />
            : <span className="size-2.5 rounded-full border-2 border-muted-foreground/60" title="Waiting on someone else" />}
      </div>

      <div className="min-w-0">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {/* A guest doesn't know session callsigns or task numbers: they see the project, the time, and whether work waits. */}
          {!guest && <ActorChip actor={q.asked_by} />}
          <ProjectChip slug={q.project} />
          <span className="tabular-nums">{ago(q.created_at)}</span>
          {q.task_id && !guest && (
            <button onClick={() => go({ task: q.task_id! })} title={`Open task #${q.task_id}`}
              className={cn('-mx-1 inline-flex items-baseline gap-1 rounded px-1 hover:bg-raised hover:text-foreground', holding && lit && 'font-medium text-lamp hover:text-lamp')}>
              {holding ? 'holding' : 'on'} <TaskId id={q.task_id} className="text-current" />
            </button>
          )}
          {holding && (guest || !q.task_id) && <span className={cn('font-medium', lit && 'text-lamp')}>{guest ? 'work is paused until you answer' : 'holding work'}</span>}
          <span className="callsign ml-auto text-[12px] text-muted-foreground">Q{q.id}</span>
          {!guest && <AssignPicker q={q} />}
        </header>

        {q.parent_id && (
          <p className="mt-2.5 truncate text-xs text-muted-foreground">
            Follow-up to <span className="callsign">Q{q.parent_id}</span>{q.parent_answer && <> — Q{q.parent_id} was answered {q.parent_answer}</>}
          </p>
        )}
        {prev && (
          <div className={cn('text-xs text-muted-foreground', q.parent_id ? 'mt-1' : 'mt-2.5')}>
            <button onClick={() => setShowPrev((s) => !s)} aria-expanded={showPrev}
              className="-ml-1 flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground">
              <ChevronRight className={cn('size-3.5 transition-transform duration-150', showPrev && 'rotate-90')} />
              Rewritten{rewrote ? ` (${rewrote})` : ''} · previous version
            </button>
            {showPrev && (
              <div className="mt-1 max-w-[68ch] border-l-2 pl-3 text-pretty">
                <p>{prev.body}</p>
                {prev.options?.length ? <p className="mt-1">Options: {prev.options.map((o) => o.label.replace(RECOMMENDED, '')).join(' · ')}</p> : null}
                {prev.note && <p className="mt-1">Sent back: {prev.note}</p>}
              </div>
            )}
          </div>
        )}
        <p id={`q${q.id}-body`} className={cn('max-w-[68ch] text-base leading-normal text-pretty', q.parent_id || prev ? 'mt-1' : 'mt-2.5')}>{q.body}</p>

        {q.context && (
          <div className="mt-2">
            <button onClick={() => setShowContext((s) => !s)} aria-expanded={showContext}
              className="-ml-1 flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground">
              <ChevronRight className={cn('size-3.5 transition-transform duration-150', showContext && 'rotate-90')} /> Context
            </button>
            {showContext && <Md className="mt-1 max-w-[68ch] border-l-2 pl-3 text-muted-foreground">{q.context}</Md>}
          </div>
        )}

        {q.options && q.options.length > 0 && (
          <div className="mt-4 grid gap-1.5" role={q.multi ? 'group' : undefined} aria-label={q.multi ? 'Pick any' : undefined}>
            {q.multi && <p className="mb-0.5 text-xs text-muted-foreground">Pick any that apply, then send.</p>}
            {q.options.map((o) => {
              const label = o.label.replace(RECOMMENDED, '')
              const rec = RECOMMENDED.test(o.label)
              const on = picked.includes(o.label) || busy === o.label
              return (
                <button key={o.label} disabled={!!busy || cleared} aria-pressed={q.multi ? on : undefined}
                  onClick={() => q.multi ? setPicked((p) => on ? p.filter((x) => x !== o.label) : [...p, o.label]) : send(withNote(label), o.label)}
                  className={cn('group/opt flex min-h-11 items-start gap-3 rounded-md border bg-background/50 px-3 py-2.5 text-left transition-[border-color,background-color] duration-150',
                    'hover:border-foreground/35 hover:bg-background disabled:cursor-default',
                    on && 'border-foreground bg-background')}>
                  <span className={cn('mt-0.5 grid size-4 shrink-0 place-items-center border border-foreground/30 transition-colors group-hover/opt:border-foreground/70',
                    q.multi ? 'rounded-[4px]' : 'rounded-full', on && 'border-foreground bg-foreground text-background')}>
                    {on && (busy === o.label ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" strokeWidth={3} />)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="text-sm font-medium">{label}</span>
                      {rec && <span className="ml-auto shrink-0 rounded-[3px] bg-raised px-1.5 py-px text-[11px] font-medium text-muted-foreground">Recommended</span>}
                    </span>
                    {o.description && <span className="mt-0.5 block text-[13px] leading-snug text-muted-foreground">{o.description}</span>}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {!!q.branches?.length && (
          <p className="mt-3 text-xs text-muted-foreground text-pretty">
            Then: {q.branches.map((b) => `${b.if_answer ? `if ${b.if_answer.replace(RECOMMENDED, '')}` : 'after any answer'} → ${b.body}`).join(' · ')}
          </p>
        )}

        <div className="mt-3 flex items-end gap-2">
          <VoiceTextarea value={text} onValue={setText} voice={!guest} onKeyDown={onKey} rows={1} disabled={cleared}
            placeholder={q.options?.length ? (q.multi ? 'Add a note (optional)…' : 'Or write your own answer; a note here rides along with the option you click…') : 'Write your answer…'}
            className="min-h-9 resize-y bg-background/50 text-sm" aria-label={`Answer to Q${q.id}`} />
          <Button disabled={!!busy || cleared || (q.multi ? !picked.length && !text.trim() : !text.trim())}
            onClick={sendTyped} className="h-9 shrink-0 gap-1.5" title="Send (Ctrl+Enter)">
            {busy === '__text' && <Loader2 className="size-3.5 animate-spin" />}
            Send <Kbd className="hidden bg-transparent text-current opacity-70 sm:inline-flex"><CornerDownLeft className="size-3" /></Kbd>
          </Button>
        </div>
        {!cleared && (
          <div className="mt-1.5 -ml-1.5 flex flex-wrap items-center gap-1.5">
            {!guest && <AlreadyRuled q={q} disabled={!!busy} onPick={(m) => send(`Already ruled: M${m.id} ${m.title}`, '__ruled', m.id)} />}
            <span className="ml-1.5 inline-flex items-center gap-1 px-0.5 text-xs text-muted-foreground" title={`Back to ${guest ? 'whoever asked' : q.asked_by} to rewrite; it comes back here. A note typed above rides along.`}>
              <Undo2 className="size-3" /> Send back:
            </span>
            {BACK_REASONS.map((r) => (
              <button key={r.key} disabled={!!busy} onClick={() => sendBack(r.key)}
                className={cn('inline-flex min-h-8 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-raised hover:text-foreground disabled:opacity-50',
                  armed === r.key && 'bg-raised font-medium text-foreground')}>
                {busy === `__back:${r.key}` && <Loader2 className="size-3 animate-spin" />}{armed === r.key ? `${r.label}: tap again, your text goes as the note` : r.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </article>
  )
}

export const changeable = (q: Question) => q.status === 'answered' || q.status === 'delivered'

/** The box that changes an answer. A delivered one goes back to its session as a correction (#1346). */
export function ChangeAnswer({ q, onDone }: { q: Question; onDone: () => void }) {
  const qc = useQueryClient()
  const [text, setText] = useState(q.answer ?? '')
  async function save() {
    try {
      await rpc('answer', { id: q.id, answer: text })
      toast.success(`Changed the answer to Q${q.id}`, q.status === 'delivered' ? { description: 'The session gets it as a correction.' } : undefined)
      onDone()
      await qc.invalidateQueries()
    } catch (e: any) { toast.error(`Could not change Q${q.id}`, { description: e.message }) }
  }
  return (
    <div className="mt-2">
      <div className="flex gap-2">
        <Textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={2} className="text-sm" aria-label={`New answer to Q${q.id}`}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); if (e.key === 'Escape') onDone() }} />
        <div className="flex flex-col gap-1">
          <Button size="sm" onClick={save}>Save</Button>
          <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
        </div>
      </div>
      {q.status === 'delivered' && <p className="mt-1 text-xs text-muted-foreground">Already delivered: the session is told you changed it, with the old answer.</p>}
    </div>
  )
}

/** Scrolls the row being changed into view once it is on the page: the toast's Change (#1345) can open a row the
 *  list only shows after the next fetch. */
export function useScrollToRow(editing: number | null, rows: unknown) {
  const done = useRef<number | null>(null)
  useEffect(() => {
    if (editing == null) { done.current = null; return }
    if (done.current === editing) return
    const el = document.getElementById(`answered-${editing}`)
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); done.current = editing }
  }, [editing, rows])
}

/** Who answered, when not Ahmed. Its own component: the people list is the dashboard's (a guest gets 403 on it). */
function AnsweredBy({ name }: { name: string }) {
  const { data: users = [] } = useUsers()
  return <span className="ml-2 text-xs text-muted-foreground">{users.find((u) => u.name === name)?.display ?? name} answered</span>
}

/** An answer, delivered or on its way, with Change (#1346). A guest doesn't see session names or make rules. */
export function AnsweredRow({ q, editing, onEdit, guest }: { q: Question; editing: boolean; onEdit: (on: boolean) => void; guest?: boolean }) {
  const sent = q.status === 'delivered'
  return (
    <li id={`answered-${q.id}`} className="grid scroll-mt-20 grid-cols-[1.75rem_minmax(0,1fr)] py-3 sm:grid-cols-[2.5rem_minmax(0,1fr)]">
      <span className={cn('mt-[5px] size-2.5 justify-self-center rounded-full', sent ? 'bg-clear' : q.status === 'withdrawn' ? 'border-2 border-muted-foreground/50' : 'border-2 border-clear')}
        title={sent ? 'Delivered' : q.status === 'withdrawn' ? 'Withdrawn' : 'Answered, not yet delivered'} />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 text-sm">
          {!guest && <ActorChip actor={q.asked_by} />}
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{q.body}</span>
          {!editing && !guest && <MakeRule q={q} />}
          {!editing && changeable(q) && <button onClick={() => onEdit(true)} className="rounded px-1.5 text-xs text-muted-foreground hover:bg-raised hover:text-foreground">Change</button>}
        </div>
        {editing ? <ChangeAnswer q={q} onDone={() => onEdit(false)} /> : (
          <p className="mt-1 flex items-start gap-1.5 text-sm">
            <CornerDownRight className="mt-0.5 size-3.5 shrink-0 text-clear" aria-label="Answer" />
            <span className="min-w-0">
              {q.answer}
              {!guest && q.answered_by && q.answered_by !== 'ahmed' && <AnsweredBy name={q.answered_by} />}
              <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                {sent ? `delivered${!guest && q.delivered_to ? ` to ${q.delivered_to}` : ''} ${ago(q.delivered_at)}`
                  : q.status === 'withdrawn' ? 'withdrawn' : `on its way, ${ago(q.answered_at)}`}
                {q.answer_history?.length ? ' · changed' : ''}
              </span>
            </span>
          </p>
        )}
      </div>
    </li>
  )
}

/** Sent back to its asker (#616), waiting for the rewrite: a quiet row, no lamp. A guest doesn't see session names. */
export function SentBackRow({ q, guest }: { q: Question; guest?: boolean }) {
  const r = BACK_REASONS.find((x) => x.key === q.sent_back?.reason)
  return (
    <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] py-3 sm:grid-cols-[2.5rem_minmax(0,1fr)]">
      <Undo2 className="mt-[3px] size-3.5 justify-self-center text-muted-foreground" aria-hidden />
      <div className="min-w-0 text-sm">
        <p className="truncate text-muted-foreground">{q.body}</p>
        <p className="mt-0.5 text-xs text-muted-foreground text-pretty">
          Sent back{guest ? '' : <> to <ActorChip actor={q.asked_by} /></>}: {r?.short ?? q.sent_back?.reason}
          {q.sent_back?.note && <> — <span className="text-foreground/90">{q.sent_back.note}</span></>} · waiting for the rewrite
        </p>
      </div>
    </li>
  )
}

/** Who should answer: Ahmed (default) or a guest user who answers through their link. */
function AssignPicker({ q }: { q: Question }) {
  const qc = useQueryClient()
  const { data: all = [] } = useUsers()
  // Everyone is offered (#1369); only people on the question's project can answer it, so picking someone who isn't
  // adds them to that project first, and the option says so (they then see that project's board, not just this one).
  const on = new Set(onProject(all, q.project, q.assigned_to).map((u) => u.name))
  if (!all.length) return null
  async function assign(to: string) {
    const u = all.find((x) => x.name === to)
    try {
      if (to && !on.has(to)) await rpc('user_project_add', { name: to, project: q.project })
      await rpc('question_assign', { id: String(q.id), to_user: to || null })
      toast.success(to ? `Q${q.id} is now for ${u?.display ?? to}${on.has(to) ? '' : `, added to ${q.project}`}` : `Q${q.id} is back with you`)
      await qc.invalidateQueries()
    } catch (e: any) {
      toast.error(`Could not reassign Q${q.id}`, { description: e.message })
    }
  }
  return (
    <label className="flex items-center gap-1">
      <span>For</span>
      <select value={q.assigned_to ?? ''} onChange={(e) => assign(e.target.value)}
        className="h-6 rounded border bg-card px-1 text-xs text-foreground hover:border-input">
        <option value="">Ahmed</option>
        {all.map((u) => <option key={u.name} value={u.name}>{u.display}{on.has(u.name) ? '' : ` (adds to ${q.project})`}</option>)}
      </select>
    </label>
  )
}
