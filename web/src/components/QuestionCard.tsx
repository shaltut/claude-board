import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, CornerDownLeft, CornerDownRight, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { onProject, rpc, useUsers, type Question } from '@/lib/api'
import { ago } from '@/lib/format'
import { go } from '@/lib/route'
import { Textarea } from '@/components/ui/textarea'
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
        <p id={`q${q.id}-body`} className={cn('max-w-[68ch] text-base leading-normal text-pretty', q.parent_id ? 'mt-1' : 'mt-2.5')}>{q.body}</p>

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
          <Textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} rows={1} disabled={cleared}
            placeholder={q.options?.length ? (q.multi ? 'Add a note (optional)…' : 'Or write your own answer; a note here rides along with the option you click…') : 'Write your answer…'}
            className="min-h-9 resize-y bg-background/50 text-sm" aria-label={`Answer to Q${q.id}`} />
          <Button disabled={!!busy || cleared || (q.multi ? !picked.length && !text.trim() : !text.trim())}
            onClick={sendTyped} className="h-9 shrink-0 gap-1.5" title="Send (Ctrl+Enter)">
            {busy === '__text' && <Loader2 className="size-3.5 animate-spin" />}
            Send <Kbd className="hidden bg-transparent text-current opacity-70 sm:inline-flex"><CornerDownLeft className="size-3" /></Kbd>
          </Button>
        </div>
        {!guest && !cleared && (
          <div className="mt-1.5 -ml-1.5">
            <AlreadyRuled q={q} disabled={!!busy} onPick={(m) => send(`Already ruled: M${m.id} ${m.title}`, '__ruled', m.id)} />
          </div>
        )}
      </div>
    </article>
  )
}

/** Answered but not yet picked up by the orchestrator. Still editable. */
export function AnsweredRow({ q, editing, onEdit }: { q: Question; editing: boolean; onEdit: (on: boolean) => void }) {
  const qc = useQueryClient()
  const [text, setText] = useState(q.answer ?? '')
  const { data: users = [] } = useUsers()
  async function save() {
    try {
      await rpc('answer', { id: q.id, answer: text })
      toast.success(`Changed the answer to Q${q.id}`)
      onEdit(false)
      await qc.invalidateQueries()
    } catch (e: any) { toast.error(e.message) }
  }
  return (
    <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] py-3 sm:grid-cols-[2.5rem_minmax(0,1fr)]">
      <span className="mt-[5px] size-2.5 justify-self-center rounded-full border-2 border-clear" title="Answered, not yet delivered" />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 text-sm">
          <ActorChip actor={q.asked_by} />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{q.body}</span>
          {!editing && <MakeRule q={q} />}
          {!editing && <button onClick={() => onEdit(true)} className="rounded px-1.5 text-xs text-muted-foreground hover:bg-raised hover:text-foreground">Change</button>}
        </div>
        {editing ? (
          <div className="mt-2 flex gap-2">
            <Textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={2} className="text-sm" aria-label={`New answer to Q${q.id}`}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); if (e.key === 'Escape') onEdit(false) }} />
            <div className="flex flex-col gap-1">
              <Button size="sm" onClick={save}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => onEdit(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <p className="mt-1 flex items-start gap-1.5 text-sm">
            <CornerDownRight className="mt-0.5 size-3.5 shrink-0 text-clear" aria-label="Answer" />
            <span className="min-w-0">
              {q.answer}
              {q.answered_by && q.answered_by !== 'ahmed' && (
                <span className="ml-2 text-xs text-muted-foreground">{users.find((u) => u.name === q.answered_by)?.display ?? q.answered_by} answered</span>
              )}
            </span>
          </p>
        )}
      </div>
    </li>
  )
}

/** Who should answer: Ahmed (default) or a guest user who answers through their link. */
function AssignPicker({ q }: { q: Question }) {
  const qc = useQueryClient()
  const { data: all = [] } = useUsers()
  const users = onProject(all, q.project, q.assigned_to) // only people on this question's project can take it
  if (!users.length) return null
  async function assign(to: string) {
    try {
      await rpc('question_assign', { id: String(q.id), to_user: to || null })
      toast.success(to ? `Q${q.id} is now for ${users.find((u) => u.name === to)?.display ?? to}` : `Q${q.id} is back with you`)
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
        {users.map((u) => <option key={u.name} value={u.name}>{u.display}</option>)}
      </select>
    </label>
  )
}
