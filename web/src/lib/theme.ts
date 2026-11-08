import { useSyncExternalStore } from 'react'

type Theme = 'dark' | 'light'

let theme: Theme = (() => {
  try { return (localStorage.getItem('cb-theme') as Theme) || 'dark' } catch { return 'dark' }
})()
const subs = new Set<() => void>()

export function applyTheme() {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

function set(t: Theme) {
  theme = t
  applyTheme()
  try { localStorage.setItem('cb-theme', t) } catch { /* private mode */ }
  subs.forEach((f) => f())
}

/** One shared theme for the whole page (top bar toggle, toasts). */
export function useTheme() {
  const t = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f) }, () => theme)
  return { theme: t, toggle: () => set(t === 'dark' ? 'light' : 'dark') }
}
