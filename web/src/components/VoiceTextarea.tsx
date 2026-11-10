import { useRef } from 'react'
import { Mic } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useVoice, useVoiceLang, voiceOn, voiceSupported } from '@/lib/voice'
import { Textarea } from '@/components/ui/textarea'

/** A Textarea you can talk into (#658): hold Space in it, or hold the mic. Where the browser has no speech
 *  recognition (Firefox), or voice is off (a guest's card), it is a plain Textarea. */
export function VoiceTextarea({ value, onValue, voice = true, onKeyDown, disabled, className, ...props }:
  Omit<React.ComponentProps<'textarea'>, 'value' | 'onChange'> & { value: string; onValue: (v: string) => void; voice?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const on = voiceOn(voiceSupported, voice, !!disabled)
  const v = useVoice(ref, onValue, on)
  const { lang, toggle } = useVoiceLang()
  const hint = 'Hold Space or hold this button to talk'

  return (
    <div className="min-w-0 flex-1">
      <div className="relative">
        <Textarea ref={ref} value={value} onChange={(e) => onValue(e.target.value)} disabled={disabled} dir="auto" {...props}
          onKeyDown={(e) => { if (on) v.onKeyDown(e); onKeyDown?.(e) }}
          onKeyUp={on ? v.onKeyUp : undefined} onBlur={on ? v.onBlur : undefined}
          className={cn(className, on && 'pr-[4.5rem]')} />
        {on && (
          <div className="absolute right-1 bottom-1 flex items-center">
            <button type="button" onClick={toggle} onMouseDown={(e) => e.preventDefault()}
              title={lang === 'en-US' ? 'Dictating in English. Switch to Arabic' : 'Dictating in Arabic. Switch to English'}
              aria-label={`Dictation language: ${lang === 'en-US' ? 'English' : 'Arabic'}. Switch`}
              className="h-7 rounded px-1.5 text-[11px] font-medium text-muted-foreground hover:bg-raised hover:text-foreground">
              {lang === 'en-US' ? 'EN' : 'AR'}
            </button>
            <button type="button" aria-label={hint} title={hint} aria-pressed={v.listening}
              onPointerDown={(e) => { if (e.button) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); v.press() }}
              onPointerUp={v.release} onPointerCancel={v.release} onContextMenu={(e) => e.preventDefault()}
              onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); v.press() } }}
              onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') v.release() }}
              className={cn('grid size-7 touch-none place-items-center rounded text-muted-foreground select-none hover:bg-raised hover:text-foreground',
                v.listening && 'bg-raised text-destructive hover:text-destructive')}>
              <Mic className="size-3.5" />
            </button>
          </div>
        )}
      </div>
      {v.listening && (
        <p className="mt-1 flex items-baseline gap-1.5 text-xs text-muted-foreground" aria-live="polite">
          <span className="size-1.5 shrink-0 translate-y-[-1px] animate-pulse rounded-full bg-destructive" aria-hidden />
          <span className="shrink-0">Listening…</span>
          <span dir="auto" className="min-w-0 opacity-70">{v.interim}</span>
        </p>
      )}
      {v.error && !v.listening && <p className="mt-1 text-xs text-destructive" role="status">{v.error}</p>}
    </div>
  )
}
