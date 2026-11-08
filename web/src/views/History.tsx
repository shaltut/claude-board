import type { Route } from '@/lib/route'

export function History({ route }: { route: Route }) {
  return <div className="p-6 text-muted-foreground">History · {route.project ?? 'all'}</div>
}
