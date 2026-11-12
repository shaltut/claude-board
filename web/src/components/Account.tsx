import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { KeyRound, LogOut } from 'lucide-react'
import { get, type User } from '@/lib/api'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

export type Who = { role: 'local' } | { role: 'admin' | 'guest'; user: User } | { role: 'anonymous' }
export const useWho = () => useQuery({ queryKey: ['whoami'], queryFn: () => get<Who>('/api/whoami'), staleTime: Infinity })

export async function signOut() {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {})
  location.replace('/login')
}

/** Who is signed in, Change password and Sign out. Nothing on the PC board's own screen (role local: no sign-in there). */
export function Account({ user, compact }: { user: User; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      {/* the board's top bar is full at laptop widths: there the name is in Sign out's tooltip */}
      <span className={`hidden truncate text-sm text-muted-foreground ${compact ? '2xl:inline' : 'md:inline'}`}>Signed in as <span className="text-foreground">{user.display}</span></span>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} aria-label="Change your password" title="Change your password"
        className="text-muted-foreground">
        <KeyRound />{!compact && <span className="hidden sm:inline">Password</span>}
      </Button>
      <Button size="sm" variant="ghost" onClick={signOut} className="text-muted-foreground" title={`Sign out ${user.display}`}>
        <LogOut /><span className="hidden sm:inline">Sign out</span>
      </Button>
      <ChangePassword open={open} onOpenChange={setOpen} />
    </>
  )
}

function ChangePassword({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  function close(o: boolean) { onOpenChange(o); if (!o) { setCurrent(''); setNext(''); setError('') } }
  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const r = await fetch('/api/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ current, password: next }) })
      if (r.ok) { toast.success('Password changed', { description: 'Use the new one next time you sign in.' }); close(false) }
      else setError((await r.json().catch(() => null))?.error ?? 'Could not change it. Try again.')
    } catch { setError('Could not reach the board. Try again in a moment.') }
    setBusy(false)
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={save} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Change your password</DialogTitle>
            <DialogDescription>If you signed in with a link and have no password yet, leave the current one empty.</DialogDescription>
          </DialogHeader>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Current password</span>
            <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" className="h-9" />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">New password</span>
            <Input type="password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password"
              placeholder="8 characters or more" className="h-9" />
          </label>
          <p role="alert" className="min-h-5 text-sm text-destructive">{error}</p>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
