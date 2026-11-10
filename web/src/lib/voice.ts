import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from 'react'

/** Hold Space this long in an answer box and it records instead of typing (#658). */
export const HOLD_MS = 350

export type Hold =
  | { phase: 'idle' }
  | { phase: 'holding'; at: number; typed: number } // Space is down, not yet long enough; `typed` spaces went into the box
  | { phase: 'recording' }
  | { phase: 'spent' } // recording is over (Esc, or it ended itself) but Space is still down: swallow it until released

export type HoldEvent =
  | { type: 'down'; t: number; repeat: boolean; plain: boolean } // a Space keydown; plain = no modifier keys
  | { type: 'up' } // Space released
  | { type: 'timer'; t: number } // the HOLD_MS timer armed on the first keydown
  | { type: 'escape' } | { type: 'other' } | { type: 'blur' } | { type: 'ended' } // other key; focus left; recognition ended itself
  | { type: 'off' } // the box went disabled (answered, sent back) or voice was turned off: its key handlers are gone

/** type = let the keydown type its space; prevent = swallow it; start = swallow, take the `remove` typed spaces back out, record. */
export type HoldAction = { do: 'none' | 'type' | 'prevent' | 'start' | 'stop' | 'cancel'; remove?: number }

const IDLE: Hold = { phase: 'idle' }

/** The hold-to-talk decision, as a pure step: tap types a space, a hold records, release stops, Esc cancels. */
export function holdStep(s: Hold, e: HoldEvent): [Hold, HoldAction] {
  if (e.type === 'off') return [IDLE, { do: s.phase === 'recording' ? 'cancel' : 'none' }]
  switch (s.phase) {
    case 'idle':
      if (e.type !== 'down') return [s, { do: 'none' }]
      return e.plain && !e.repeat ? [{ phase: 'holding', at: e.t, typed: 1 }, { do: 'type' }] : [s, { do: 'type' }]
    case 'holding':
      if (e.type === 'down' || e.type === 'timer') {
        if (e.t - s.at >= HOLD_MS) return [{ phase: 'recording' }, { do: 'start', remove: s.typed }]
        return e.type === 'down' ? [{ ...s, typed: s.typed + 1 }, { do: 'type' }] : [s, { do: 'none' }]
      }
      return [IDLE, { do: 'none' }] // released early (a tap), or another key / Esc / blur: plain typing
    case 'recording':
      if (e.type === 'down') return [s, { do: 'prevent' }]
      if (e.type === 'up' || e.type === 'blur') return [IDLE, { do: 'stop' }]
      if (e.type === 'ended') return [{ phase: 'spent' }, { do: 'stop' }]
      if (e.type === 'escape') return [{ phase: 'spent' }, { do: 'cancel' }]
      return [s, { do: 'none' }]
    case 'spent':
      if (e.type === 'down') return [s, { do: 'prevent' }]
      return e.type === 'up' || e.type === 'blur' ? [IDLE, { do: 'none' }] : [s, { do: 'none' }]
  }
}

type Key = { key: string; repeat: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean; isComposing: boolean }

/** A keyboard event as the step sees it; null = not ours (IME composition, or a key going up that isn't Space). */
export function holdEvent(kind: 'keydown' | 'keyup', k: Key, t: number): HoldEvent | null {
  if (k.isComposing || k.key === 'Process') return null
  if (k.key === ' ') return kind === 'keyup' ? { type: 'up' } : { type: 'down', t, repeat: k.repeat, plain: !(k.ctrlKey || k.altKey || k.metaKey || k.shiftKey) }
  if (kind === 'keyup') return null
  return k.key === 'Escape' ? { type: 'escape' } : { type: 'other' }
}

/** Puts heard text in place of [start, end), with a space either side only where a word would touch it. */
export function insertText(value: string, start: number, end: number, text: string) {
  const t = text.trim()
  if (!t) return { value, caret: end }
  const before = value.slice(0, start), after = value.slice(end)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && !/^\s/.test(after) ? ' ' : ''
  return { value: before + lead + t + trail + after, caret: before.length + lead.length + t.length }
}

/** Where heard text goes when recording ends. The snapshot's range only if the text is untouched since; if he typed
 *  meanwhile, that range now holds other text, so it goes in at the current caret and replaces nothing. */
export function insertSpot(snap: { value: string; start: number; end: number }, value: string, caret: number) {
  return value === snap.value ? { start: snap.start, end: snap.end } : { start: caret, end: caret }
}

/** Voice shows only where the browser has it, the box allows it (Ahmed's, not a guest's: #658 accepted Google for him) and is enabled. */
export const voiceOn = (supported: boolean, voice: boolean, disabled: boolean) => supported && voice && !disabled

// --- the browser side -------------------------------------------------------------------------------

// Chrome, Edge and Safari have it (Chrome sends the audio to Google: accepted in #658); Firefox doesn't, so no mic shows there.
const SR: any = typeof window === 'undefined' ? undefined : (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
export const voiceSupported = !!SR

export type VoiceLang = 'en-US' | 'ar-SA'
let lang: VoiceLang = (() => { try { return localStorage.getItem('cb-voice-lang') === 'ar-SA' ? 'ar-SA' : 'en-US' } catch { return 'en-US' } })()
const subs = new Set<() => void>()

/** EN / AR for dictation: one setting for every box, remembered per browser. */
export function useVoiceLang() {
  const l = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f) }, () => lang)
  return {
    lang: l,
    toggle: () => {
      lang = l === 'en-US' ? 'ar-SA' : 'en-US'
      try { localStorage.setItem('cb-voice-lang', lang) } catch { /* private mode */ }
      subs.forEach((f) => f())
    },
  }
}

const ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone blocked. Allow it for this site, then try again.',
  'service-not-allowed': 'Microphone blocked. Allow it for this site, then try again.',
  'audio-capture': 'No microphone found.',
  'network': 'Speech service unreachable.',
  'no-speech': "Didn't catch anything.",
  'language-not-supported': "This browser can't dictate in that language.",
}

type Spot = { value: string; start: number; end: number }

/** Dictation into a controlled textarea: hold Space in it (the key handlers) or hold the mic button (press/release).
 *  The interim transcript is shown, never written; the final one lands at the caret when recording stops. */
export function useVoice(ref: RefObject<HTMLTextAreaElement | null>, setValue: (v: string) => void, on: boolean) {
  const { lang } = useVoiceLang()
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [error, setError] = useState<string | null>(null)
  const hold = useRef<Hold>(IDLE)
  const snap = useRef<Spot | null>(null)
  const rec = useRef<{ r: any; cancelled: boolean } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const sel = useRef<[number, number] | null>(null)

  // A selection set before React has written the new value would be lost, so it waits for the commit.
  useLayoutEffect(() => {
    if (sel.current && ref.current) { ref.current.setSelectionRange(...sel.current); sel.current = null }
  })
  useEffect(() => () => { clearTimeout(timer.current); cancel() }, [])
  // Disabled mid-hold (Ctrl+Enter sent it): keyup and blur no longer reach us, so close the mic here.
  useEffect(() => { if (!on) { step({ type: 'off' }); cancel() } }, [on])

  function apply(v: string, a: number, b: number) {
    const el = ref.current
    if (!el) return
    if (v === el.value) el.setSelectionRange(a, b)
    else { sel.current = [a, b]; setValue(v) }
  }

  function cancel() {
    if (!rec.current || rec.current.cancelled) return
    rec.current.cancelled = true
    rec.current.r.abort()
  }
  const stop = () => rec.current?.r.stop() // results still arrive after stop(); onend inserts them

  function begin(at: Spot) {
    if (!SR || rec.current) return
    setError(null)
    const r = new SR()
    r.lang = lang
    r.continuous = true
    r.interimResults = true
    const me = { r, cancelled: false }
    let heard = ''
    r.onresult = (e: any) => {
      heard = ''
      for (let i = 0; i < e.results.length; i++) heard += e.results[i][0].transcript // cumulative: finals plus the live tail
      setInterim(heard.trim())
    }
    r.onerror = (e: any) => { if (e.error !== 'aborted') setError(ERRORS[e.error] ?? 'Voice input failed. Try again.') }
    r.onend = () => {
      rec.current = null
      window.removeEventListener('blur', stop)
      setListening(false)
      setInterim('')
      hold.current = holdStep(hold.current, { type: 'ended' })[0]
      const el = ref.current
      if (me.cancelled || !el || !heard.trim()) return
      const spot = insertSpot(at, el.value, el.selectionEnd)
      const { value, caret } = insertText(el.value, spot.start, spot.end, heard)
      apply(value, caret, caret)
    }
    try { r.start() } catch { setError('Voice input failed. Try again.'); return }
    rec.current = me
    window.addEventListener('blur', stop) // the permission prompt or an Alt+Tab swallows the release
    setListening(true)
  }

  function step(ev: HoldEvent, e?: KeyboardEvent) {
    const was = hold.current.phase
    const [next, a] = holdStep(hold.current, ev)
    hold.current = next
    const el = ref.current
    if (was === 'idle' && next.phase === 'holding' && el) {
      snap.current = { value: el.value, start: el.selectionStart, end: el.selectionEnd } // before the space goes in
      clearTimeout(timer.current)
      const t = next.at + HOLD_MS // repeat delay is the OS's (250 ms to 1 s), so a timer, not auto-repeat, decides
      timer.current = setTimeout(() => step({ type: 'timer', t }), HOLD_MS)
    }
    if (next.phase !== 'holding') clearTimeout(timer.current)
    if (a.do === 'prevent' || a.do === 'start' || a.do === 'cancel') e?.preventDefault()
    if (a.do === 'cancel') e?.stopPropagation()
    if (a.do === 'start' && snap.current) {
      // The snapshot is exactly the text before the hold, even when the first space replaced a selection.
      const s = snap.current
      apply(s.value, s.start, s.end)
      begin(s)
    }
    if (a.do === 'stop') stop()
    if (a.do === 'cancel') cancel()
  }

  const key = (kind: 'keydown' | 'keyup') => (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const ev = holdEvent(kind, e.nativeEvent, performance.now())
    if (ev) step(ev, e)
  }

  return {
    listening, interim, error,
    onKeyDown: key('keydown'), onKeyUp: key('keyup'), onBlur: () => step({ type: 'blur' }),
    /** The mic button: at the caret if the box has focus, else at the end. */
    press: () => {
      const el = ref.current
      if (!el || hold.current.phase !== 'idle') return
      const focused = document.activeElement === el
      begin({ value: el.value, start: focused ? el.selectionStart : el.value.length, end: focused ? el.selectionEnd : el.value.length })
    },
    release: () => { if (hold.current.phase === 'idle') stop() },
  }
}
