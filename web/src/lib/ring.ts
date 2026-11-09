import { useEffect, useRef, useSyncExternalStore } from 'react'

/** Ring when an id is waiting that wasn't before. `prev` null = nothing loaded yet: the first load never rings. */
export function shouldRing(prev: ReadonlySet<number> | null, next: readonly number[]): boolean {
  return prev !== null && next.some((id) => !prev.has(id))
}

let muted = (() => { try { return localStorage.getItem('cb-ring') === 'off' } catch { return false } })()
const subs = new Set<() => void>()

/** The top bar's bell: on by default, remembered per browser. */
export function useRingMuted() {
  const m = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f) }, () => muted)
  return {
    muted: m,
    toggle: () => {
      muted = !m
      try { localStorage.setItem('cb-ring', muted ? 'off' : 'on') } catch { /* private mode */ }
      subs.forEach((f) => f())
    },
  }
}

let ctx: AudioContext | undefined
let last = 0

// Browsers only let an AudioContext start after a gesture, so the first click or key creates it.
function unlock() {
  try { ctx ??= new AudioContext(); if (ctx.state !== 'running') ctx.resume().catch(() => {}) } catch { /* no Web Audio */ }
}

/** A soft two-tone chime, ~0.5 s. Silent until the page has had a click or key, when muted, or within 3 s of the last one. */
function ring() {
  if (muted || !ctx || Date.now() - last < 3000) return
  last = Date.now()
  const c = ctx
  c.resume().catch(() => {}) // idle tabs can get suspended again
  const t = c.currentTime
  for (const [freq, at] of [[659.25, 0], [987.77, 0.13]]) { // E5 then B5
    const osc = c.createOscillator(), gain = c.createGain()
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0.0001, t + at)
    gain.gain.exponentialRampToValueAtTime(0.18, t + at + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.38)
    osc.connect(gain).connect(c.destination)
    osc.start(t + at)
    osc.stop(t + at + 0.4)
  }
}

/** Rings when a question id joins the set waiting on the viewer. Pass undefined until the data has loaded. */
export function useRing(ids: number[] | undefined) {
  const prev = useRef<Set<number> | null>(null)
  const key = ids?.join(',')
  useEffect(() => {
    if (!ids) return
    if (shouldRing(prev.current, ids)) ring()
    prev.current = new Set(ids)
  }, [key]) // key stands for ids: a fresh array each render, same contents
  useEffect(() => {
    window.addEventListener('click', unlock, true)
    window.addEventListener('keydown', unlock, true)
    return () => { window.removeEventListener('click', unlock, true); window.removeEventListener('keydown', unlock, true) }
  }, [])
}
