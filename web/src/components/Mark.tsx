import { useEffect } from 'react'
import { cn } from '@/lib/utils'

/** The mark: a "C" racked from three strips, with the call lamp in its mouth.
 *  Same geometry as public/favicon.svg. Amber lamp = something waits on Ahmed; green = all clear. */
export const markSvg = (lamp: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#14201F"/><g fill="#E3EBE8"><rect x="6" y="6" width="16" height="5.5" rx="2.75"/><rect x="6" y="20.5" width="20" height="5.5" rx="2.75"/><rect x="6" y="6" width="5.5" height="20" rx="2.75"/></g><circle cx="20.5" cy="16" r="4.5" fill="${lamp}"/></svg>`

const AMBER = '#FFB43C', GREEN = '#4FD69C'

export function Mark({ lit = true, className }: { lit?: boolean; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-6 shrink-0 [&>svg]:size-full', className)}
    dangerouslySetInnerHTML={{ __html: markSvg(lit ? AMBER : GREEN) }} />
}

/** The browser tab shows the same lamp and the count, so a background tab tells Ahmed whether anyone is holding. */
export function useTabLamp(waiting: number) {
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (link) link.href = `data:image/svg+xml,${encodeURIComponent(markSvg(waiting > 0 ? AMBER : GREEN))}`
    document.title = waiting > 0 ? `(${waiting}) Claude Board` : 'Claude Board'
  }, [waiting])
}
