import { Bell, BellOff, Moon, Sun } from 'lucide-react'
import { useTheme } from '@/lib/theme'
import { useRingMuted } from '@/lib/ring'

export function ThemeToggle() {
  const { theme, toggle } = useTheme()
  return (
    <button onClick={toggle} className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-raised hover:text-foreground"
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
      {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  )
}

/** Mutes the chime that plays when a new question waits on you. */
export function RingToggle() {
  const { muted, toggle } = useRingMuted()
  const label = muted ? 'Ring when a question comes in' : 'Mute the new-question ring'
  return (
    <button onClick={toggle} aria-label={label} title={label}
      className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-raised hover:text-foreground">
      {muted ? <BellOff className="size-4" /> : <Bell className="size-4" />}
    </button>
  )
}
