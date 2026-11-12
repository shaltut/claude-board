import { useState } from 'react'
import { Mark } from '@/components/Mark'
import { ThemeToggle } from '@/components/ThemeToggle'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

/** For everyone reaching the board without a cookie (on the VPS: everyone): name and password; members can also use
 *  their private link. Guest style: calm, one column. */
export function Login() {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function signIn(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password }) })
      if (r.ok) { location.replace('/'); return }
      setError((await r.json().catch(() => null))?.error ?? 'Could not sign in. Try again.')
    } catch { setError('Could not reach the board. Try again in a moment.') }
    setBusy(false)
  }

  return (
    <div className="min-h-dvh">
      <header className="border-b">
        <div className="mx-auto flex h-13 max-w-2xl items-center gap-2.5 px-4 sm:px-6">
          <Mark />
          <span className="text-[15px] font-semibold tracking-tight [font-stretch:88%]">Claude Board</span>
          <span className="ml-auto"><ThemeToggle /></span>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-sm px-4 pt-14 pb-20 sm:pt-20">
        <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.015em]">Sign in</h1>
        <p className="mt-2 text-sm text-muted-foreground text-pretty">
          Use your name and password. If Ahmed sent you a private link, opening it signs you in too.
        </p>
        <form onSubmit={signIn} className="mt-8 grid gap-4">
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Name</span>
            <Input autoFocus required value={name} onChange={(e) => setName(e.target.value)} autoComplete="username"
              autoCapitalize="off" spellCheck={false} className="h-10" />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Password</span>
            <Input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className="h-10" />
          </label>
          <p role="alert" className="min-h-5 text-sm text-destructive">{error}</p>
          <Button type="submit" size="lg" disabled={busy} className="h-10">{busy ? 'Signing in…' : 'Sign in'}</Button>
        </form>
      </main>
    </div>
  )
}
