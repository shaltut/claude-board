import type { Route } from '@/lib/route'

export function Today({ route }: { route: Route }) {
  return <div className="p-6 text-muted-foreground">Today · {route.project ?? 'all'}</div>
}
