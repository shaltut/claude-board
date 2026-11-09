import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { BookMarked } from 'lucide-react'
import { toast } from 'sonner'
import { rpc, useMemFind, useMemories, type Memory, type Question } from '@/lib/api'
import { go } from '@/lib/route'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

/** On an answered question: save the answer as a ruling, so a session that would ask it again reads it instead.
 *  Once saved, the button becomes a link to the ruling. */
export function MakeRule({ q }: { q: Question }) {
  const qc = useQueryClient()
  const { data: mems = [] } = useMemories(q.project)
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  if (!q.answer || (q.status !== 'answered' && q.status !== 'delivered')) return null
  // answered "Already ruled": it already is one
  const has = q.ruled_by ? mems.find((m) => m.id === q.ruled_by) ?? { id: q.ruled_by, title: '', status: 'active' }
    : mems.find((m) => Number(m.source.question_id) === q.id && (m.status === 'active' || m.status === 'proposed'))
  if (has) return (
    <button onClick={() => go({ view: 'memory', project: q.project, task: undefined })} title={has.title}
      className="inline-flex items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:bg-raised hover:text-foreground">
      <BookMarked className="size-3" /> {has.status === 'proposed' ? 'Proposed as' : 'Rule'} M{has.id}
    </button>
  )
  async function save(e: React.FormEvent) {
    e.preventDefault()
    try {
      const m = await rpc<Memory>('mem_rule', { question: q.id, title })
      toast(`M${m.id} saved: ${q.project} sessions see it from now on`)
      setOpen(false)
      await qc.invalidateQueries()
    } catch (err: any) { toast.error(err.message) }
  }
  return (
    <>
      <button onClick={() => { setTitle((q.answer ?? '').replace(/\s+/g, ' ').slice(0, 200)); setOpen(true) }}
        className="inline-flex items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:bg-raised hover:text-foreground">
        <BookMarked className="size-3" /> Make it a rule
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={save} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Make Q{q.id} a rule</DialogTitle>
              <DialogDescription>
                Every {q.project} session is told this when it starts, so it acts on your answer instead of asking again.
                Write it as the rule, in one line.
              </DialogDescription>
            </DialogHeader>
            <p className="rounded-md border bg-raised/40 px-3 py-2 text-sm text-pretty text-muted-foreground">
              {q.body}<br /><span className="font-medium text-foreground">{q.answer}</span>
            </p>
            <Input autoFocus required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="The rule, in one line" />
            <DialogFooter><Button type="submit">Save rule</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** On an open question: you ruled on this before. Pick the live entry and it is the answer, rule and all (#553). */
export function AlreadyRuled({ q, disabled, onPick }: { q: Question; disabled?: boolean; onPick: (m: Memory) => void }) {
  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState('')
  const { data: found = [], isFetching } = useMemFind(term, q.project)
  return (
    <>
      <button disabled={disabled} onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:bg-raised hover:text-foreground disabled:opacity-50">
        <BookMarked className="size-3" /> Already ruled
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Q{q.id} is already ruled</DialogTitle>
            <DialogDescription>
              Pick the rule. It becomes the answer, so {q.asked_by} gets the rule itself, and it counts toward the weekly memory metric.
            </DialogDescription>
          </DialogHeader>
          <p className="rounded-md border bg-raised/40 px-3 py-2 text-sm text-pretty text-muted-foreground">{q.body}</p>
          <Input autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search live rules, rulings, facts…" aria-label="Search memory" />
          <ul className="-mx-2 max-h-72 overflow-y-auto" aria-live="polite">
            {term.trim().length > 1 && !isFetching && found.length === 0 && <li className="px-2 py-3 text-sm text-muted-foreground">No live entry matches.</li>}
            {found.map((m) => (
              <li key={m.id}>
                <button onClick={() => { setOpen(false); onPick(m) }}
                  className="grid w-full gap-0.5 rounded-md px-2 py-2 text-left hover:bg-raised">
                  <span className="flex items-baseline gap-2">
                    <span className="callsign shrink-0 text-[13px] text-muted-foreground">M{m.id}</span>
                    <span className="min-w-0 text-sm font-medium text-pretty">{m.title}</span>
                  </span>
                  {m.body && <span className="line-clamp-2 pl-9 text-xs text-muted-foreground">{m.body}</span>}
                </button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  )
}
