/** Rank for a task dropped at `index` in a list (sorted by rank) that excludes the task itself. */
export function rankAt(list: { rank: number }[], index: number): number {
  const prev = list[index - 1]?.rank
  const next = list[index]?.rank
  if (prev == null && next == null) return 0
  if (prev == null) return next! - 1024
  if (next == null) return prev + 1024
  return (prev + next) / 2
}

/**
 * Index (in the target list without the dragged task) where a drop lands, matching dnd-kit's
 * sortable preview. Same column: the dragged card takes the over card's slot (arrayMove), so
 * moving down lands after it. Another column: before the card it is over; on the column: at the end.
 * Returns null when the card is dropped where it already is.
 */
export function dropIndex(column: { id: number }[], activeId: number, overId: number | string, sameColumn: boolean): number | null {
  const from = column.findIndex((x) => x.id === activeId)
  const over = column.findIndex((x) => x.id === overId)
  if (sameColumn) {
    const to = over === -1 ? column.length - 1 : over
    return to === from ? null : to
  }
  return over === -1 ? column.length : over
}

type Queued = { id: number; priority: string; rank: number; goal_rank?: number | null }

/** A card's goal lift (#663): the rank of its top active goal; P0 and cards in no goal have none. */
const lift = (x: Pick<Queued, 'priority' | 'goal_rank'>) => (x.priority === 'P0' ? null : x.goal_rank ?? null)

/** Queue order everywhere, as cb next hands out: P0, then active goal cards in goal order, then priority, then Ahmed's drag order. */
export function byQueue(a: Queued, b: Queued): number {
  const la = lift(a), lb = lift(b)
  return Number(a.priority !== 'P0') - Number(b.priority !== 'P0')
    || (la === lb ? 0 : la === null ? 1 : lb === null ? -1 : la - lb)
    || a.priority.localeCompare(b.priority) || a.rank - b.rank || a.id - b.id
}

/**
 * Rank for card `t` dropped at `index` of `list` (queue-ordered, dragged card excluded). Only cards of its band
 * count (same priority, same goal lift): dropping above the band lands at its top, below it at its bottom.
 */
export function bandRank(list: Queued[], index: number, t: Pick<Queued, 'priority' | 'goal_rank'>): number {
  const same = (x: Queued) => x.priority === t.priority && lift(x) === lift(t)
  return rankAt(list.filter(same), list.slice(0, index).filter(same).length)
}
