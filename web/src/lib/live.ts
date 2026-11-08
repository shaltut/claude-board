import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

/** One SSE stream; any DB change re-fetches visible queries. The DB stays the only source of truth. */
export function useLive(): 'live' | 'reconnecting' {
  const qc = useQueryClient()
  const [state, setState] = useState<'live' | 'reconnecting'>('reconnecting')
  useEffect(() => {
    const es = new EventSource('/api/stream')
    let timer: ReturnType<typeof setTimeout> | undefined
    es.addEventListener('hello', () => setState('live'))
    es.addEventListener('change', () => {
      clearTimeout(timer) // one write fires several notifications; refetch once
      timer = setTimeout(() => qc.invalidateQueries(), 120)
    })
    es.onerror = () => setState('reconnecting')
    es.onopen = () => { setState('live'); qc.invalidateQueries() }
    return () => { clearTimeout(timer); es.close() }
  }, [qc])
  return state
}
