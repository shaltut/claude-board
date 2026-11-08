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
