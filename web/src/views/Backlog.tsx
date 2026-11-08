import type { Route } from '@/lib/route'

export function Backlog({ route }: { route: Route }) {
  return <div className="p-6 text-muted-foreground">Backlog · {route.project ?? 'all'}</div>
}
