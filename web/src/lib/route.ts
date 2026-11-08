import { useEffect, useState } from 'react'

export type View = 'today' | 'board' | 'backlog' | 'sessions' | 'history' | 'questions'
export const VIEWS: View[] = ['today', 'board', 'backlog', 'sessions', 'history']

export interface Route { view: View; project?: string; task?: number; tag?: string; actor?: string }

/** Hash routes: #/board?p=<project>&t=<task id>&g=<tag>. The task panel opens over whatever view is showing. */
export function parse(hash = location.hash): Route {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?')
  const p = new URLSearchParams(query)
  const view = (['today', 'board', 'backlog', 'sessions', 'history', 'questions'].includes(path) ? path : 'today') as View
  const t = Number(p.get('t'))
  return { view, project: p.get('p') || undefined, task: t > 0 ? t : undefined, tag: p.get('g') || undefined, actor: p.get('a') || undefined }
}

export function href(r: Route) {
  const p = new URLSearchParams()
  if (r.project) p.set('p', r.project)
  if (r.task) p.set('t', String(r.task))
  if (r.tag) p.set('g', r.tag)
  if (r.actor) p.set('a', r.actor)
  const s = p.toString()
  return `#/${r.view}${s ? `?${s}` : ''}`
}

export function go(patch: Partial<Route>) {
  location.hash = href({ ...parse(), ...patch })
}

export function useRoute(): Route {
  const [r, setR] = useState(parse)
  useEffect(() => {
    const on = () => setR(parse())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return r
}
