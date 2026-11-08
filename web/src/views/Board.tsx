import type { Route } from '@/lib/route'

export function Board({ route }: { route: Route }) {
  return <div className="p-6 text-muted-foreground">Board · {route.project ?? 'all'}</div>
}
