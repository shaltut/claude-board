import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, CornerDownLeft } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { rpc, useUsers, type Question } from '@/lib/api'
import { ago } from '@/lib/format'
import { go } from '@/lib/route'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { ActorChip, ProjectChip, TaskId } from './Chips'
import { Md } from './Md'

/** An open question from Claude, answerable in place. Draft text lives here, keyed by question id,
 *  so live refetches never wipe what Ahmed is typing. */
export function QuestionCard({ q, onAnswered, guest }: { q: Question; onAnswered?: (id: number) => void; guest?: boolean }) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [showContext, setShowContext] = useState(false)
  const [busy, setBusy] = useState(false)

  async function send(answer: string) {
    if (!answer.trim()) return
    setBusy(true)
    try {
      await rpc('answer', { id: q.id, answer })
      toast.success(`Answered Q${q.id}`, {
        description: answer.length > 80 ? answer.slice(0, 80) + '…' : answer,
        action: onAnswered ? { label: 'Change', onClick: () => onAnswered(q.id) } : undefined,
      })
      await qc.invalidateQueries()
    } catch (e: any) {
      toast.error(`Could not answer Q${q.id}`, { description: e.message })
    } finally {
      setBusy(false)
    }
  }

  const withNote = (base: string) => (text.trim() ? `${base} — ${text.trim()}` : base)
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      send(q.multi && picked.length ? withNote(picked.join('; ')) : text)
    }
  }

  return (
    <article className={cn('rounded-lg border bg-card p-4 sm:p-5',
      q.blocking && 'border-dawn/50 bg-[color-mix(in_oklab,var(--dawn)_7%,var(--card))]')}
      aria-labelledby={`q${q.id}-body`}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-mono text-dawn">Q{q.id}</span>
        <ProjectChip slug={q.project} />
        <ActorChip actor={q.asked_by} />
        <span>{ago(q.created_at)}</span>
        {q.task_id && (
          <button onClick={() => go({ task: q.task_id! })} disabled={guest} className="enabled:hover:text-foreground">
            on <TaskId id={q.task_id} />
          </button>
        )}
        {q.blocking && <span className="ml-auto rounded bg-dawn px-1.5 py-px font-medium text-background">Blocking a task</span>}
        {!guest && <AssignPicker q={q} />}
      </header>

      <p id={`q${q.id}-body`} className="mt-3 text-[15px] leading-relaxed text-pretty">{q.body}</p>

      {q.context && (
        <div className="mt-2">
          <button onClick={() => setShowContext((s) => !s)} aria-expanded={showContext}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRight className={cn('size-3.5 transition-transform', showContext && 'rotate-90')} /> Context
          </button>
          {showContext && <Md className="mt-1 border-l-2 pl-3 text-muted-foreground">{q.context}</Md>}
        </div>
      )}

      {q.options && q.options.length > 0 && (
        <div className="mt-4 grid gap-2" role={q.multi ? 'group' : undefined} aria-label={q.multi ? 'Pick any' : undefined}>
          {q.multi && <p className="text-xs text-muted-foreground">Pick any that apply, then send.</p>}
          {q.options.map((o) => {
            const on = picked.includes(o.label)
            return (
              <button key={o.label} disabled={busy}
                onClick={() => q.multi ? setPicked((p) => on ? p.filter((x) => x !== o.label) : [...p, o.label]) : send(withNote(o.label.replace(/\s*\(recommended\)\s*$/i, '')))}
                className={cn('group flex items-start gap-3 rounded-md border bg-background/60 px-3 py-2.5 text-left transition-colors hover:border-dawn/70 hover:bg-background',
                  on && 'border-dawn bg-background')}>
                <span className={cn('mt-0.5 grid size-4 shrink-0 place-items-center border text-dawn',
                  q.multi ? 'rounded-[4px]' : 'rounded-full', on && 'border-dawn bg-dawn text-background')}>
                  {on && <Check className="size-3" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{o.label}</span>
                  {o.description && <span className="block text-[13px] text-muted-foreground">{o.description}</span>}
                </span>
              </button>
            )
          })}
        </div>
      )}

      <div className="mt-3 flex items-end gap-2">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} rows={1}
          placeholder={q.options?.length ? (q.multi ? 'Add a note (optional)' : 'Or write your own answer; clicking an option adds this as a note') : 'Write your answer'}
          className="min-h-9 resize-y bg-background/60 text-sm" aria-label={`Answer to Q${q.id}`} />
        <Button disabled={busy || (q.multi ? !picked.length && !text.trim() : !text.trim())}
          onClick={() => send(q.multi && picked.length ? withNote(picked.join('; ')) : text)}
          className="shrink-0 gap-1.5" title="Send (Ctrl+Enter)">
          Send <Kbd className="hidden bg-transparent text-current sm:inline-flex"><CornerDownLeft className="size-3" /></Kbd>
        </Button>
      </div>
    </article>
  )
}

/** Answered but not yet picked up by the orchestrator. Still editable. */
export function AnsweredRow({ q, editing, onEdit }: { q: Question; editing: boolean; onEdit: (on: boolean) => void }) {
  const qc = useQueryClient()
  const [text, setText] = useState(q.answer ?? '')
  async function save() {
    try {
      await rpc('answer', { id: q.id, answer: text })
      toast.success(`Changed the answer to Q${q.id}`)
      onEdit(false)
      await qc.invalidateQueries()
    } catch (e: any) { toast.error(e.message) }
  }
  return (
    <li className="py-3">
      <div className="flex items-baseline gap-2 text-sm">
        <span className="font-mono text-xs text-muted-foreground">Q{q.id}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{q.body}</span>
        {!editing && <button onClick={() => onEdit(true)} className="text-xs text-muted-foreground hover:text-foreground">Change</button>}
      </div>
      {editing ? (
        <div className="mt-2 flex gap-2">
          <Textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={2} className="text-sm"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); if (e.key === 'Escape') onEdit(false) }} />
          <div className="flex flex-col gap-1">
            <Button size="sm" onClick={save}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => onEdit(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <p className="mt-1 pl-7 text-sm">
          <span className="text-dawn">→</span> {q.answer}
          <span className="ml-2 text-xs text-muted-foreground">
            {q.answered_by && q.answered_by !== 'ahmed' && `${q.answered_by} answered, `}for {q.asked_by}, waiting for the orchestrator
          </span>
        </p>
      )}
    </li>
  )
}

/** Who should answer: Ahmed (default) or a guest user who answers through their link. */
function AssignPicker({ q }: { q: Question }) {
  const qc = useQueryClient()
  const { data: users = [] } = useUsers()
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
    <label className={cn('flex items-center gap-1', !q.blocking && 'ml-auto')}>
      For
      <select value={q.assigned_to ?? ''} onChange={(e) => assign(e.target.value)}
        className="rounded border bg-transparent px-1 py-0.5 text-xs text-foreground">
        <option value="">Ahmed</option>
        {users.map((u) => <option key={u.name} value={u.name}>{u.display}</option>)}
      </select>
    </label>
  )
}
