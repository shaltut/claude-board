import { useEffect, useState } from 'react'

export type View = 'today' | 'board' | 'backlog' | 'sessions' | 'huddles' | 'history' | 'people' | 'epics' | 'memory' | 'questions'
export const VIEWS: View[] = ['today', 'board', 'backlog', 'sessions', 'huddles', 'history', 'people', 'epics', 'memory']

export interface Route { view: View; project?: string; task?: number; tag?: string; type?: string; actor?: string; huddle?: number; epic?: number }

/** Hash routes: #/board?p=<project>&t=<task id>&g=<tag>&k=<type>, #/epics?e=<epic id>. The task panel opens over whatever view is showing. */
export function parse(hash = location.hash): Route {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?')
  const p = new URLSearchParams(query)
  const view = ([...VIEWS, 'questions'].includes(path as View) ? path : 'today') as View
  const t = Number(p.get('t'))
  return { view, project: p.get('p') || undefined, task: t > 0 ? t : undefined, tag: p.get('g') || undefined, type: p.get('k') || undefined, actor: p.get('a') || undefined, huddle: Number(p.get('h')) || undefined, epic: Number(p.get('e')) || undefined }
}

export function href(r: Route) {
  const p = new URLSearchParams()
  if (r.project) p.set('p', r.project)
  if (r.task) p.set('t', String(r.task))
  if (r.tag) p.set('g', r.tag)
  if (r.type) p.set('k', r.type)
  if (r.actor) p.set('a', r.actor)
  if (r.huddle) p.set('h', String(r.huddle))
  if (r.epic) p.set('e', String(r.epic))
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
