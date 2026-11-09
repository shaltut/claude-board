import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { rpc, TASK_TYPES, useProjects, type Status, type Task } from '@/lib/api'
import { STATUS } from '@/lib/format'
import { go } from '@/lib/route'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'

/** `initial` and `links` apply on mount: give the dialog a `key` per draft (e.g. a huddle line). */
export function NewTask({ open, onOpenChange, project, initial, links, onCreated }: {
  open: boolean; onOpenChange: (o: boolean) => void; project?: string
  initial?: { title?: string; body?: string }; links?: Record<string, string>; onCreated?: (id: number) => void
}) {
  const qc = useQueryClient()
  const { data: projects = [] } = useProjects()
  const [proj, setProj] = useState(project ?? '')
  const [title, setTitle] = useState(initial?.title ?? '')
  const [body, setBody] = useState(initial?.body ?? '')
  const [status, setStatus] = useState<Status>('next')
  const [priority, setPriority] = useState<Task['priority']>('P2')
  const [type, setType] = useState<Task['type']>('task')

  async function create(e: React.FormEvent) {
    e.preventDefault()
    try {
      const id = await rpc<number>('task_add', { project: proj, title, body, status, priority, type, ...(links && { links }) })
      toast.success(`Created #${id}`, { action: { label: 'Open', onClick: () => go({ task: id }) } })
      setTitle(''); setBody('')
      onOpenChange(false)
      onCreated?.(id)
      await qc.invalidateQueries()
    } catch (err: any) { toast.error(err.message) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={create} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
            <DialogDescription>Tasks in Next are what sessions take with <code className="font-mono">cb next</code>.</DialogDescription>
          </DialogHeader>
          <Input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing" aria-label="Title" />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Input required list="cb-projects" value={proj} onChange={(e) => setProj(e.target.value)} placeholder="project" aria-label="Project" />
            <datalist id="cb-projects">{projects.map((p) => <option key={p.slug} value={p.slug} />)}</datalist>
            <Select value={status} onValueChange={(v) => setStatus(v as Status)}>
              <SelectTrigger className="w-full" aria-label="Status"><SelectValue /></SelectTrigger>
              <SelectContent>{(['backlog', 'next', 'in_progress'] as Status[]).map((s) => <SelectItem key={s} value={s}>{STATUS[s].label}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={priority} onValueChange={(v) => setPriority(v as Task['priority'])}>
              <SelectTrigger className="w-full" aria-label="Priority"><SelectValue /></SelectTrigger>
              <SelectContent>{(['P0', 'P1', 'P2', 'P3'] as const).map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={type} onValueChange={(v) => setType(v as Task['type'])}>
              <SelectTrigger className="w-full capitalize" aria-label="Type"><SelectValue /></SelectTrigger>
              <SelectContent>{TASK_TYPES.map((k) => <SelectItem key={k} value={k} className="capitalize">{k}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder="Details for Claude (markdown)" aria-label="Description" />
          <DialogFooter><Button type="submit">Create task</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
